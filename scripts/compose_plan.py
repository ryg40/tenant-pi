"""Pure plan of the Compose seat: the overlay, the registry, the two env files and the command lines. Nothing runs here.

The module starts no process, opens no file, and reads no environment value. It builds each
output from the answers of the guided flow and from the validated components of the manifest.
No output holds a key value: the key line of `compose.env` is empty, and the user fills it.
"""
import re
import shlex

from scripts.model_routes import ALIASES, ID, THINKING
from scripts.private_init import inside
from scripts.validate import ENV, absolute, fail, url

# A Linux account name of the portable form.
ACCOUNT = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
# Accounts that the base image holds. The seat account must be a new one.
RESERVED = frozenset(("root", "node", "sshd", "daemon", "www-data", "nobody", "bin", "sys", "sync", "games", "man", "lp",
                      "mail", "news", "uucp", "proxy", "backup", "list", "irc", "_apt"))
# The usual range of a user account. A UID or GID from 500 to 999 is a macOS account: accepted with a warning.
ID_MIN, ID_LOW, ID_MAX = 500, 1000, 65533
# The GID of `staff` on macOS. In the image, the Debian group `dialout` holds this GID.
DIALOUT_GID = 20
PORT_MIN, PORT_MAX = 1024, 65535
BIND = "127.0.0.1"
PROFILE = "/home/{account}/.pi/profiles/main"
URL_VAR = "TENANTEXT_LITELLM_BASE_URL"
# The components that the gateway route of the seat needs.
ROUTE = ("core", "model-routing", "codex-accounts")
FILES = ("overlay.json", "seat.env", "compose.env", "authorized_keys", "registry.json")
# The provider that the gateway of the pinned Tenantext registers; it has only the models of `ALIASES`.
GATEWAY_PROVIDER = "litellm-codex"
RUNTIMES = ("docker", "podman")
# The Compose steps, with the words after the file options and whether the step changes the machine.
STEPS = (("build", ("build",), True), ("up", ("up", "-d"), True), ("ps", ("ps",), False),
         ("logs", ("logs", "seat"), False), ("down", ("down",), True))
APPROVAL = "user_approval_required"
# A value that an env file holds without quotes.
PLAIN = re.compile(r"[A-Za-z0-9_./:=,@+-]*\Z")
FIELD = "compose-plan."
# One line of a public key file: the key type, the key, and an optional comment. No option before the type.
KEY_LINE = re.compile(r"(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+={0,3}(?: [^\x00-\x1f\x7f]*)?\Z")
# Byte bound of the public key file.
MAX_KEY_FILE = 64 * 1024


def public_key(data):
    """Check the bytes of the public key file that the caller read; the diagnostic holds no content.

    The file holds exactly one public key line; empty lines and comment lines are allowed. A private key is refused.
    """
    field = FIELD + "public_key"
    try:
        content = data.decode("utf-8")
    except UnicodeError:
        fail("input_encoding", field)
    if "PRIVATE KEY" in content:
        fail("private_key", field)
    lines = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]
    if not lines:
        fail("public_key_missing", field)
    if not all(KEY_LINE.match(line) for line in lines):
        fail("public_key_line", field)
    if len(lines) != 1:
        fail("public_key_count", f"{field} has {len(lines)} key lines")
    return data


def _number(value, low, high, rule, field):
    if type(value) is not int or not low <= value <= high:
        fail(rule, FIELD + field)
    return value


def _env_value(value):
    """One value of an env file. Single quotes keep it literal; a value with a single quote gets double quotes.

    A validated path holds no `$`, no backquote, no backslash and no line end.
    """
    if PLAIN.match(value):
        return value
    if "'" not in value:
        return "'" + value + "'"
    return '"' + value.replace('"', '\\"') + '"'


def _selection(components, known):
    """The enabled IDs: the route components, the chosen components, and each component that one of them requires."""
    if type(components) not in (list, tuple) or any(type(cid) is not str for cid in components):
        fail("component_list", FIELD + "components")
    if len(set(components)) != len(components):
        fail("duplicate_component", FIELD + "components")
    enabled, pending = [], [*ROUTE, *components]
    while pending:
        cid = pending.pop(0)
        if cid in enabled:
            continue
        if cid not in known:
            fail("undeclared_component", FIELD + "components")
        enabled.append(cid)
        pending.extend(known[cid]["requires"])
    enable = ["core", *sorted(set(enabled) - {"core"})]
    return enable, sorted(set(known) - set(enable)), sorted(set(enable) - set(ROUTE) - set(components))


def _command(step, runtime, words, changes, clone, files):
    """One Compose command. `KIT_COMMIT` comes from the checkout at the time of the command."""
    commit = ["git", "-C", clone, "rev-parse", "--short", "HEAD"]
    argv = [runtime, "compose", *files, *words]
    command = {"step": step, "runtime": runtime, "argv": argv, "kitCommit": commit,
               "display": 'KIT_COMMIT="$(' + shlex.join(commit) + ')" ' + shlex.join(argv), "changes": changes}
    if changes:
        command["approval"] = APPROVAL
    return command


def compose_plan(account, uid, gid, public_key_path, ssh_port, projects_dir, gateway_url, key_var, components,
                 private_dir, clone_dir, *, known, model, provider=GATEWAY_PROVIDER, thinking="high"):
    """The files and the command lines of one Compose seat, as data. The caller writes and runs nothing here.

    `known` is the component map that `scripts.validate.manifest` returns. `projects_dir` is None
    without a projects directory. `provider`, `model` and `thinking` are the interactive role; they stay
    separate values. The caller validates `overlay` with `scripts.validate.overlay` and, with `registry`,
    with `scripts.model_routes.render`: these two judge a model of another provider.
    """
    if not isinstance(account, str) or not ACCOUNT.match(account):
        fail("account", FIELD + "account")
    if account in RESERVED:
        fail("reserved_account", FIELD + "account")
    _number(uid, ID_MIN, ID_MAX, "account_id", "uid")
    if gid != DIALOUT_GID:
        _number(gid, ID_MIN, ID_MAX, "account_id", "gid")
    _number(ssh_port, PORT_MIN, PORT_MAX, "port", "ssh_port")
    for value, field in ((public_key_path, "public_key"), (private_dir, "private_dir"), (clone_dir, "clone"),
                         *(((projects_dir, "projects_dir"),) if projects_dir is not None else ())):
        absolute(value, FIELD + field)
        if value != "/" and value.endswith("/"):
            fail("absolute_path", FIELD + field)
    # The private directory holds the key file: it stays outside the checkout, which is the build context.
    if inside(private_dir, clone_dir) or inside(clone_dir, private_dir):
        fail("under_kit", FIELD + "private_dir")
    # The overlay validator has the URL rule: HTTPS, no credential, no port other than 443.
    url(gateway_url, FIELD + "gateway_url")
    if not gateway_url.endswith("/v1"):
        fail("gateway_api_prefix", FIELD + "gateway_url")
    if not isinstance(key_var, str) or not ENV.match(key_var) or key_var == URL_VAR or key_var.startswith("SEAT_"):
        fail("env_name", FIELD + "key_var")
    enable, disable, added = _selection(components, known)
    for value, field in ((provider, "provider"), (model, "model")):
        if not isinstance(value, str) or not ID.match(value):
            fail("model_id", FIELD + field)
    if not isinstance(thinking, str) or thinking not in THINKING:
        fail("thinking", FIELD + "thinking")
    if provider == GATEWAY_PROVIDER and model not in ALIASES:
        fail("unsupported_gateway_model", FIELD + "model")
    choice = {"provider": provider, "model": model, "thinking": thinking, "route": "gateway"}

    overlay = {
        "schemaVersion": 1,
        "target": {"agentDir": PROFILE.format(account=account)},
        "selection": {"enable": enable, "disable": disable},
        "paths": {}, "roles": {"interactive": dict(choice)},
        "endpoints": {"codex-accounts": gateway_url},
        "env": {"codex-accounts": "${" + key_var + "}"},
        "inputs": {"modelsFile": None, "mcpFile": "inputs/mcp-adapter.json" if "mcp" in enable else None},
        "consent": {"memoryCapture": False, "remoteMemoryWrites": False, "telemetry": False},
        # The interactive role is the first entry of the cycle: Pi starts on the first enabled model.
        "modelRoutes": {"schemaVersion": 1, "cycle": [dict(choice)], "gateway": {"auth": "env"}},
    }
    paths = {name: private_dir.rstrip("/") + "/" + name for name in FILES}
    seat_env = [
        "# The variables that Compose reads through --env-file. No secret. The gateway key is in compose.env.",
        "SEAT_PRIVATE_DIR=" + _env_value(private_dir),
        "SEAT_USER=" + account,
        f"SEAT_UID={uid}",
        f"SEAT_GID={gid}",
        "SEAT_BIND=" + BIND,
        f"SEAT_SSH_PORT={ssh_port}",
        f"# Empty for Docker. For Podman: SEAT_USERNS=keep-id:uid={uid},gid={gid}",
        "SEAT_USERNS=",
        "SEAT_KEY_VAR=" + key_var,
        *(("SEAT_PROJECTS_DIR=" + _env_value(projects_dir),) if projects_dir is not None else ()),
    ]
    compose_env = [
        "# The environment of the container. Mode 600. Do not give this file to --env-file.",
        "# The user pastes the key value between the single quotes. Compose keeps a single-quoted value literal.",
        key_var + "=''",
        "# Optional: the launcher of the profile holds the URL from the overlay.",
        URL_VAR + "=" + gateway_url,
    ]
    compose = clone_dir.rstrip("/") + "/deploy/compose/"
    files = ["--env-file", paths["seat.env"], "-f", compose + "compose.yaml",
             *(("-f", compose + "compose.projects.yaml") if projects_dir is not None else ())]
    commands = [_command(step, runtime, words, changes, clone_dir, files)
                for runtime in RUNTIMES for step, words, changes in STEPS]
    login = ["ssh", "-p", str(ssh_port), account + "@" + BIND]
    commands.append({"step": "login", "runtime": "ssh", "argv": login, "display": shlex.join(login), "changes": False})

    warnings = ["inspect_shows_key_value", "bind_0_0_0_0_opens_seat_to_network"]
    if gid == DIALOUT_GID:
        warnings.append("gid_20_is_dialout_in_image")
    if uid < ID_LOW:
        warnings.append("uid_below_1000")
    if gid < ID_LOW and gid != DIALOUT_GID:
        warnings.append("gid_below_1000")
    if "mcp" in enable:
        warnings.append("mcp_input_file_required")
    return {
        "runs": False,
        "answers": {"account": account, "uid": uid, "gid": gid, "publicKey": public_key_path, "sshPort": ssh_port,
                    "projectsDir": projects_dir, "gatewayUrl": gateway_url, "keyVar": key_var,
                    "components": list(components), "componentsAdded": added, "privateDir": private_dir,
                    "clone": clone_dir, "provider": provider, "model": model, "thinking": thinking},
        "overlay": overlay,
        # The capability map that `validate`, `plan` and `generate` need for the role model.
        "registry": {provider: {model: [thinking]}},
        "files": paths,
        "seatEnv": seat_env,
        "composeEnv": compose_env,
        "authorizedKeys": {"source": public_key_path, "destination": paths["authorized_keys"]},
        "commands": commands,
        "warnings": warnings,
    }
