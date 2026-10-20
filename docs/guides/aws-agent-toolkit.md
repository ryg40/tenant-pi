# Agent Toolkit for AWS

The Agent Toolkit for AWS (`aws/agent-toolkit-for-aws`, Apache-2.0) gives a coding agent AWS skills and the managed AWS MCP server. The kit does not ship the toolkit. This guide says how to add it to Claude Code, to a Pi profile of the kit and to the live Pi of a user.

## What the toolkit is

- A plugin marketplace. The plugin `aws-core` holds 25 skills, one PreToolUse hook and one MCP server entry `aws-mcp`. The other plugins are `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops` and `aws-startup-advisor`.
- The skills are directories with a `SKILL.md`, below `plugins/aws-core/skills/`. Pi and Claude Code read the same form.
- The hook `secret-safety.py` blocks a direct read of an AWS Secrets Manager secret value. It uses only the Python standard library.
- The `aws-mcp` entry runs `uvx mcp-proxy-for-aws-cli==1.7.0 https://aws-mcp.us-east-1.api.aws/mcp --skip-auth`. The proxy then sends unsigned requests.

The repository has no release tag. Pin a commit. This guide uses commit `26c84e3608abb0076edf86b4c81dc879ac999ccb` of 2026-10-20, plugin `aws-core` version 1.1.0.

## Credentials

Without credentials the endpoint accepts an unsigned MCP session and lists its tools. The toolkit README says that documentation search needs no authentication, and that an AWS API call or a script run needs credentials. Not verified: which tools answer an unsigned call.

- The kit stores no AWS credential, no profile name and no account ID.
- A signed setup uses the proxy with an AWS profile in `AWS_MCP_PROXY_PROFILES`. Use a profile with read-only rights only. The toolkit adds IAM condition keys that a policy can use to allow only read actions through the MCP server.
- Not verified: a signed session with this kit.

## Get the pinned copy

```sh
git clone https://github.com/aws/agent-toolkit-for-aws.git ~/.local/share/agent-toolkit-for-aws
git -C ~/.local/share/agent-toolkit-for-aws checkout --detach 26c84e3608abb0076edf86b4c81dc879ac999ccb
```

One copy serves Claude Code and Pi. To move the pin, fetch, check out the new commit and start a new session.

## Claude Code

```sh
claude plugin marketplace add ~/.local/share/agent-toolkit-for-aws
claude plugin install aws-core@agent-toolkit-for-aws --scope user
claude mcp list
```

`claude mcp list` shows `plugin:aws-core:aws-mcp` as connected. The first start downloads the proxy package through `uvx`, so `uv` must be on `PATH`. A folder marketplace keeps the pin; the official marketplace entry `aws-core@claude-plugins-official` follows the upstream head.

## Pi profile of the kit

Two parts of the kit carry the toolkit into a generated profile.

1. The skills: add the skills directory of the pinned copy to [`ownerResources`](../owner-extensions.md#owner-skill-and-prompt-directories-in-the-overlay) in the overlay. The path is absolute.

   ```json
   {
     "ownerResources": {
       "skills": ["/home/EXAMPLE_USER/.local/share/agent-toolkit-for-aws/plugins/aws-core/skills"]
     }
   }
   ```

2. The MCP server: enable the `mcp` component and put the `aws-mcp` entry into `inputs/mcp-adapter.json` of the private directory. See [workflow modules](../workflow-modules.md) for the input slot.

   ```json
   {
     "mcpServers": {
       "aws-mcp": {"url": "https://aws-mcp.us-east-1.api.aws/mcp", "lifecycle": "lazy"}
     }
   }
   ```

The entry uses the HTTPS endpoint directly, with no proxy and no credential. The kit refuses a `command` that is not an absolute path, so the `uvx` form of the plugin does not pass. A signed setup needs the proxy as an absolute command, for example after `uv tool install mcp-proxy-for-aws-cli==1.7.0`. Not verified: the signed proxy form in a kit profile.

The kit does not load the hook of the plugin in Pi. Pi has no PreToolUse hook of that form.

## Live Pi of a user

The kit does not change the live profile. For a user-level setup by hand:

1. Add the skills directory of the pinned copy to the `skills` array of `~/.pi/agent/settings.json`. Pi then lists the 25 skills.
2. Add the `aws-mcp` entry above to `~/.pi/agent/mcp-adapter.json`. `/mcp-adapter status` then lists the server.

Back up both files first.

## Checks

`tests/test_aws_agent_toolkit.py` validates the two JSON examples of this guide with the overlay validator and the MCP validator of the kit. Not verified: a Pi start of a generated profile with the toolkit.
