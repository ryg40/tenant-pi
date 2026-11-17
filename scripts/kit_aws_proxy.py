#!/usr/bin/env python3
"""The kit launcher of the aws-mcp server of aws-core, for Pi and Claude Code.

Usage: kit_aws_proxy.py mcp-proxy-for-aws-cli==<version> <endpoint> [<proxy options>]

It starts `uvx mcp-proxy-for-aws-cli==<version> <endpoint> ...` (the pinned proxy) and replaces itself with it.

Unsigned by default. The proxy option --skip-auth only allows missing credentials: the proxy signs each request
when the AWS credential chain finds credentials. So without the opt-in, the launcher starts the proxy with an
empty credential chain:
- it removes each AWS_* variable of its environment except AWS_REGION, AWS_DEFAULT_REGION and AWS_CA_BUNDLE;
- it removes each BOTO* variable (BOTO_CONFIG, BOTOCORE_EXPERIMENTAL__PLUGINS and the others);
- it sets AWS_SHARED_CREDENTIALS_FILE, AWS_CONFIG_FILE and BOTO_CONFIG to os.devnull, which is not a regular file:
  botocore reads no shared file, no config file, no ~/.boto and no /etc/boto.cfg;
- it sets AWS_EC2_METADATA_DISABLED=true (no instance metadata credentials).

The providers of the pinned botocore 1.43.83 (botocore/credentials.py, create_credential_resolver) and what closes
each of them:
- env (AWS_ACCESS_KEY_ID and the other key variables): the AWS_* variables are gone;
- assume-role, assume-role-with-web-identity, sso, login, custom-process (credential_process) and config-file: they
  read the profile of AWS_CONFIG_FILE, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE; the config file is os.devnull
  and the variables are gone;
- shared-credentials-file: AWS_SHARED_CREDENTIALS_FILE is os.devnull;
- ec2-credentials-file (AWS_CREDENTIAL_FILE): the variable is gone;
- boto-config (BOTO_CONFIG, else /etc/boto.cfg and ~/.boto): BOTO_CONFIG is os.devnull;
- container-role (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or _FULL_URI): the variables are gone;
- iam-role (instance metadata): AWS_EC2_METADATA_DISABLED=true.

The opt-in: AWS_MCP_PROXY_PROFILES names one or more AWS profiles (space-separated). Then the environment stays as
it is, and the proxy signs with the first profile. The launcher writes no file and reads no credential.
"""
import os
import re
import sys

PROXY = re.compile(r"mcp-proxy-for-aws-cli==\d+\.\d+\.\d+")
OPT_IN = "AWS_MCP_PROXY_PROFILES"
# The AWS_* variables that hold no credential and no credential source; the unsigned mode keeps them.
KEEP = ("AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CA_BUNDLE")


def environment(env):
    """The environment of the proxy: unchanged with the opt-in, else with an empty AWS credential chain."""
    if env.get(OPT_IN, "").strip():
        return dict(env)
    clean = {key: value for key, value in env.items()
             if not key.startswith(("AWS_", "BOTO")) or key in KEEP}
    clean.update(AWS_SHARED_CREDENTIALS_FILE=os.devnull, AWS_CONFIG_FILE=os.devnull, BOTO_CONFIG=os.devnull,
                 AWS_EC2_METADATA_DISABLED="true")
    return clean


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args or not PROXY.fullmatch(args[0]):
        print("kit_aws_proxy: the first argument must be mcp-proxy-for-aws-cli==<version>", file=sys.stderr)
        return 2
    try:
        os.execvpe("uvx", ["uvx", *args], environment(os.environ))
    except OSError as error:
        print("kit_aws_proxy: cannot start uvx (" + type(error).__name__ + "); install uv: https://docs.astral.sh/uv/",
              file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main())
