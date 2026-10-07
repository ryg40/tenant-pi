"""Pure SSH command lines for the remote stages of a guided install. Nothing runs here.

The module starts no process, opens no file, and reads no environment value. It builds each
command from three explicit inputs: the SSH target, the remote account and its home directory.
A command line has no SSH option: the configuration, the keys, the agent and the known hosts
of the user stay in force, so host key verification is never turned off.
"""
import re
import shlex

from scripts.validate import absolute, fail

# A host alias, a host name or an address, with an optional `<user>@`. No port, no option, no space:
# a port or a jump host belongs to the SSH configuration of the user.
TARGET = re.compile(r"(?:([a-z_][a-z0-9_-]{0,31})@)?([A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)\Z")
# A Linux account name of the portable form.
USER = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
# Home-relative places of the guided install on the remote host.
PATHS = (("clone", "tenant-pi"), ("privateDir", ".config/tenant-pi"), ("profile", ".pi/profiles/main"),
         ("herdrConfig", ".config/herdr"))
HERDR_SKILL = "packages/tenantext/skills/herdr/SKILL.md"
HOST_KEY_RULE = "unchanged"
APPROVAL = "user_approval_required"


def _remote(argv):
    """One remote command as the single string that SSH gives to the login shell of the account."""
    return shlex.join(argv)


def _stage(name, target, command, *, changes=False):
    # `--` ends the SSH options: the target and the command are never read as an option.
    argv = ["ssh", "--", target, command]
    stage = {"stage": name, "argv": argv, "display": shlex.join(argv), "changes": changes}
    if changes:
        stage["approval"] = APPROVAL
    return stage


def remote_plan(target, user, home):
    """The ordered SSH command lines of the remote stages, as data. The caller runs none of them here.

    `target` is the SSH target of the user, `user` the account that owns the install, and `home` its
    absolute home directory. A target that names another account than `user` is refused: each
    ordinary step runs as the account that owns the install.
    """
    found = TARGET.match(target) if isinstance(target, str) else None
    if not found:
        fail("ssh_target", "remote-plan.ssh_target")
    if not isinstance(user, str) or not USER.match(user):
        fail("remote_user", "remote-plan.remote_user")
    if found.group(1) is not None and found.group(1) != user:
        fail("ssh_user_mismatch", "remote-plan.ssh_target")
    absolute(home, "remote-plan.remote_home")
    if home != "/" and home.endswith("/"):
        fail("absolute_path", "remote-plan.remote_home")
    paths = {key: home.rstrip("/") + "/" + rest for key, rest in PATHS}
    cli = ["python3", paths["clone"] + "/scripts/tenant_pi.py"]
    overlay = paths["privateDir"] + "/overlay.json"
    # The values are quoted for the remote shell; `$HOME` and `$(id -un)` are the only expansions.
    identity = ('test "$(id -un)" = ' + shlex.quote(user) + ' && test "$HOME" = ' + shlex.quote(home)
                + " && test \"$(uname -s)\" = Linux")
    stages = [
        _stage("identity", target, identity),
        _stage("home-owner", target, _remote(["stat", "-c", "%U", "--", home])),
        _stage("tools", target, "node --version && npm --version && python3 --version && git --version"),
        _stage("herdr", target, "command -v herdr && herdr --version"),
        _stage("check-runtime", target, _remote([*cli, "check-runtime"])),
        _stage("check-herdr", target, _remote([*cli, "check-herdr"])),
        _stage("herdr-skill-files", target, _remote(["test", "-r", paths["clone"] + "/" + HERDR_SKILL])),
        _stage("init-private", target, _remote([*cli, "init-private", "--dir", paths["privateDir"],
                                                "--target", paths["profile"]]), changes=True),
        _stage("plan", target, _remote([*cli, "plan", "--overlay", overlay])),
        _stage("generate", target, _remote([*cli, "generate", "--overlay", overlay, "--target", paths["profile"]]),
               changes=True),
        _stage("inventory", target, _remote([*cli, "inventory", "--dir", paths["profile"]])),
    ]
    return {"runs": False, "sshTarget": target, "remoteUser": user, "remoteHome": home, "paths": paths,
            "hostKeyChecking": HOST_KEY_RULE, "stages": stages}
