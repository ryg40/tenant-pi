# Agent Toolkit for AWS

The Agent Toolkit for AWS (`aws/agent-toolkit-for-aws`, Apache-2.0) gives a coding agent AWS skills and the AWS MCP Server. The kit installs it as six optional rows, all off by default. `install.sh` clones the upstream repository at one pinned commit into a folder of the kit. Pi gets the skills and the server `aws-mcp`. Claude Code gets the plugins after a separate yes. Both harnesses start `aws-mcp` with the same kit launcher, unsigned by default.

The pin is commit `2b762874f54913b9b43d1aa59a464b67486fbd85` of 2026-11-16, with the proxy `mcp-proxy-for-aws-cli` 1.8.0. The upstream repository has no release tag. `source` in `config/manifest.json` holds the URL and the commit.

## What the rows give

| Row | Pi | Claude Code, after the yes |
| --- | --- | --- |
| `aws-core` | The skills of the plugin `aws-core`: infrastructure as code, core services, databases, observability, messaging, the AWS SDKs, cost and Well-Architected reviews. With `mcp` or `mcp-codemode`, the server `aws-mcp`. | The plugin `aws-core`: the skills and its hook `secret-safety.py`. The kit server `aws-mcp` replaces the server of the plugin. |
| `aws-agents` | The skills of the plugin `aws-agents`: AI agents with Amazon Bedrock AgentCore. | The plugin, with its MCP server `awsknowledge`. |
| `aws-data-analytics` | The skills of the plugin `aws-data-analytics`: data lakes, AWS Glue, Athena, Amazon Redshift, OpenSearch, Amazon MSK, Flink and Amazon MWAA. | The plugin. The kit turns off its own server `aws-mcp`. |
| `aws-agents-for-devsecops` | The skills of the plugin `aws-agents-for-devsecops`: AWS DevOps Agent and AWS Security Agent. | The plugin, with its MCP server `aws-devops-agent`. That server needs a token in `DEVOPS_AGENT_TOKEN`; the kit sets no token. |
| `aws-startup-advisor` | The skills of the plugin `aws-startup-advisor`: a small architecture, a move from another cloud, Amazon Bedrock and AWS Activate. | The plugin, with a hook, commands and agents. The kit turns off its own server `aws-mcp`. |
| `aws-emulator` | The skill `aws-emulator` alone: install, start and connect AWS Emulator, and check whether a project works on it. | The plugin `aws-core` carries the skill. Without `aws-core`, the kit links the skill to `~/.claude/skills/aws-emulator`. |

- The four plugin rows other than `aws-core` need `aws-core`. `install.sh` refuses one of them without `aws-core`. On the screen, the row turns `aws-core` on, and `aws-core` off turns the row off.
- `aws-emulator` does not need `aws-core`. The skill holds documents only, and it says that the AWS MCP server cannot reach a local emulator: calls to the emulator go through the AWS CLI or an SDK. The skill is in the pinned repository (`plugins/aws-core/skills/aws-emulator`), so the row is pinned by the commit like the others.
- Pi gets only the skills of the four other plugins, not their MCP servers, hooks or commands.
- The kit item `claude-aws-plugins` shows the state of the Claude Code plugins in the inventory and on the screen.

`--with all` leaves the AWS rows out. Name them in `--with`:

```sh
./install.sh --new aws --shell bash --with mcp,aws-core,aws-agents --yes
```

## Needs

- `git` on `PATH`, and network access to GitHub for the first clone. Without `git`, `install.sh` stops before its first write.
- `uv`: the server `aws-mcp` starts with `uvx`, which downloads the proxy from PyPI at the first start. Without `uvx`, the installer prints one line and goes on. Install uv from [the uv documentation](https://docs.astral.sh/uv/).
- AWS access for real AWS work: an AWS account, and a profile or other credentials of your own. The kit writes no AWS profile, no credential and no account value. The toolkit and the skill `signing-in-to-aws` describe the setup of AWS access.

Warning: the skills guide the agent to run AWS commands with your AWS access. Such commands can change resources and cost money.

## The clone

The clone is `~/.local/share/tenant-pi/git/github.com/aws/agent-toolkit-for-aws`, detached at the pin. One clone serves each profile and Claude Code.

- A run at the same pin fetches nothing and changes no file.
- A run after a pin move of the kit fetches the commit and checks it out.
- A refused clone step stops the run before the profile step.

The run refuses the clone in these cases:

- A symlink at `~/.local/share/tenant-pi/git` or below it, up to the clone and its `.git`. The run also compares the resolved path of the clone with the resolved kit folder.
- A folder that is not a clone of the URL.
- A tracked change or an untracked file. A file that git hides from its status with `assume-unchanged` or `skip-worktree` also counts.
- An ignored file in `plugins/` or `.claude-plugin/`: agents read these trees. Python bytecode caches (`__pycache__`) and `.DS_Store` files are accepted. Ignored files in other folders are accepted.
- A key of the local git config that `git clone` does not write, for example a hook path, `core.fsmonitor`, a filter or an include.
- A `HEAD` that differs from the pin after the checkout.

Each git command of the installer runs without hooks and without code from the git config. The options are `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.allow=never` with `protocol.https.allow=always`, an empty `credential.helper`, no submodule recursion, no automatic gc, and `/dev/null` for `core.excludesFile` and `core.attributesFile`. The environment has `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0` and `GIT_NO_REPLACE_OBJECTS=1`, and no inherited `GIT_*` variable. The first clone uses no template (`--template=`). So your own git config does not apply to the clone. A proxy in `HTTPS_PROXY` still applies.

## The server aws-mcp in Pi

With `aws-core` and `mcp`, the installer adds the server `aws-mcp` to `<profile>/mcp-adapter.json`. With `mcp-codemode`, it adds it to `<profile>/mcp.json`. Without one of them, it writes no entry and says so. The arguments come from `plugins/aws-core/mcp.json` of the pinned clone. The command is the launcher `scripts/kit_aws_proxy.py` of this kit; `<kit>` is the folder of the kit:

```json
{
  "mcpServers": {
    "aws-mcp": {
      "command": "python3",
      "args": ["<kit>/scripts/kit_aws_proxy.py", "mcp-proxy-for-aws-cli==1.8.0",
               "https://aws-mcp.us-east-1.api.aws/mcp", "--skip-auth", "--metadata", "INSTALL_SOURCE=agent-toolkit-core"],
      "description": "AWS MCP Server of the Agent Toolkit for AWS: AWS documentation, Regions and AWS API calls (tenant-pi kit entry)",
      "lifecycle": "lazy"
    }
  }
}
```

The file `<profile>/kit-aws.json` records each `aws-mcp` entry that the kit wrote. The kit replaces or removes an entry only while it equals the record. An entry that you changed is yours: the run keeps it and prints one line. An `aws-mcp` entry without a record is yours too, also with the kit `description`. `--adopt-aws` replaces your entry with the entry of the kit.

The server gives eight tools, for example `aws___search_documentation`, `aws___read_documentation`, `aws___list_regions` and `aws___run_script`. Documentation search needs no credential.

## Signing

The proxy has no switch that turns signing off. Its option `--skip-auth` only allows missing credentials: the proxy signs when the AWS credential chain finds credentials. So the kit launcher starts the proxy with an empty credential chain, unless you name a profile:

- It removes each `AWS_*` variable except `AWS_REGION`, `AWS_DEFAULT_REGION` and `AWS_CA_BUNDLE`.
- It removes each `BOTO*` variable, for example `BOTO_CONFIG`.
- It sets `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` and `BOTO_CONFIG` to `/dev/null`. Then botocore reads no shared file, no config file, no `~/.boto` and no `/etc/boto.cfg`.
- It sets `AWS_EC2_METADATA_DISABLED=true`.

This closes each provider of the credential chain of botocore 1.43.83, the version that the proxy pins:

| Provider | What closes it |
| --- | --- |
| Environment variables | The `AWS_*` variables are gone. |
| Assume role, web identity, SSO, login, `credential_process`, keys in the config file | The config file is `/dev/null`. `AWS_PROFILE`, `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` are gone. |
| Shared credentials file | `AWS_SHARED_CREDENTIALS_FILE` is `/dev/null`. |
| Legacy EC2 file (`AWS_CREDENTIAL_FILE`) | The variable is gone. |
| Legacy Boto file (`BOTO_CONFIG`, `/etc/boto.cfg`, `~/.boto`) | `BOTO_CONFIG` is `/dev/null`. |
| Container credentials | The `AWS_CONTAINER_*` variables are gone. |
| Instance metadata | `AWS_EC2_METADATA_DISABLED=true`. |

The proxy then finds no credentials, and `--skip-auth` sends each request unsigned. Documentation search and the Region tools work unsigned. The launcher writes no file and reads no credential. A new pin of the proxy can bring a new botocore; check its provider list before a pin move.

To sign with one profile, set `AWS_MCP_PROXY_PROFILES` to its name before you start Pi or Claude Code. Then the launcher keeps the environment as it is:

```sh
AWS_MCP_PROXY_PROFILES=my-readonly-profile pi
```

The proxy reads the variable from the environment of the agent. The first name is the default profile. More names, separated by spaces, can be selected per call. Use a profile with read-only rights.

Warning: with `AWS_MCP_PROXY_PROFILES` set, the server signs its calls with your AWS access.

## Claude Code

The Claude Code parts of the AWS rows need their own yes: `--claude-aws`, or a yes to the question after the module choice. One yes covers the plugins of all chosen AWS rows. `--yes` does not give it. Without a terminal and without `--claude-aws`, the run changes no AWS part in Claude Code. Other kit steps, for example the kit skill links in `~/.claude/skills`, do not need this yes. Without `~/.claude` or the `claude` command, the run skips the step.

After the yes, the run:

1. Adds the folder marketplace `agent-toolkit-for-aws` at the clone, when it is absent.
2. Adds an entry to `deniedMcpServers` in `~/.claude/settings.json` for the `aws-mcp` server of each kit plugin that has one (`aws-core`, `aws-data-analytics`, `aws-startup-advisor`). The entry names the exact command of that server, so Claude Code does not start it. A deny entry matches a server command from any source. So while the row is on, a server of yours with the identical command is off too.
3. Adds the user-scope server `aws-mcp` with `claude mcp add-json --scope user`. It is the kit launcher of Pi, unsigned by default.
4. Installs the plugin of each chosen row with `claude plugin install <row>@agent-toolkit-for-aws --scope user`.
5. Updates a kit plugin whose recorded commit differs from the pin. The run fails when a kit plugin is absent or off the pin after this step.
6. Uninstalls the kit plugin of a row that is off.

The record `~/.local/share/tenant-pi/kit-aws-claude.json` holds what the kit made: the plugin ids with their scope, the server, the `deniedMcpServers` entries and the `aws-emulator` link. The run uninstalls, updates or removes only a part that the record names, and only while it equals the record. A plugin is the kit's only in the recorded scope. The same plugin in another scope is yours, and it stays.

The record names a part before the kit makes it, and keeps a part until its removal is confirmed. So a run that stops halfway does not forget a kit part. The `deniedMcpServers` entries and the kit server stay until the run confirms the removal of each kit plugin, or its move to the pin. After a failed uninstall or a failed update, they stay, and the next run that succeeds takes them out.

The record files `kit-aws.json` and `kit-aws-claude.json` are trusted data of your user account. The kit cannot tell an entry that equals a recorded one from its own: an entry equal to the recorded one counts as the kit's.

The plugins are for your user, not for one Pi profile: each Claude Code session gets them. The plugin files in the clone stay as upstream wrote them, and the hook `secret-safety.py` of `aws-core` stays on. Its matcher `mcp__aws.*` also covers the tools of the kit server.

These parts of your own stay, with one line each. `--adopt-aws` makes them the kit's and moves them to the kit pin:

- A marketplace named `agent-toolkit-for-aws` with another source. With it, the run makes no plugin change.
- An installed AWS plugin from another marketplace, for example `aws-core@claude-plugins-official`.
- An installed plugin of the kit marketplace that the record does not name. Without `--adopt-aws`, the run does not update it and does not uninstall it.
- A user-scope server `aws-mcp` that the record does not name.
- A Pi skills entry for the same plugin folder of another clone.

A `deniedMcpServers` entry that equals a kit entry stays when the row goes off, if it was there before the kit wrote its entry. If you write an equal entry while the record names one, it counts as the kit's, and it goes when the row goes off.

The kit does not write a `~/.claude/settings.json` that is a symlink or that it cannot read. Then the run installs and updates no plugin with an `aws-mcp` server, and the Claude Code step fails with one line.

The kit writes `~/.claude/settings.json` as a whole, with the indent that it found. It writes the file only while the file holds what the kit read. After a change by another program, it reads the file again and applies its edit to the new content. After three changes, the step fails with one line and no write. When the rows go off, the kit takes out its own entries. It also takes out the key `deniedMcpServers` when the kit made the key and it is empty again, and the file when the kit made the file and it is empty again.

Not the same as upstream: Claude Code lists the server as `aws-mcp`, not as `plugin:aws-core:aws-mcp`. The kit server starts the proxy from PyPI (`mcp-proxy-for-aws-cli==1.8.0`), not from the git source of the plugin entry.

## Turn a row off or move the pin

On an upgrade, the AWS rows follow the selection. A row that the kit installed and that the selection leaves out is turned off, and the plan shows `-remove`. The run removes only what the kit wrote:

- The skills entries that name the clone.
- The `aws-mcp` entry that `kit-aws.json` records, while it is unchanged.
- With `--claude-aws`: the plugins, the server, the `deniedMcpServers` entries and the `aws-emulator` link that `kit-aws-claude.json` records.

Your own entries, the marketplace and the clone stay. Without `--claude-aws`, the Claude Code parts stay, and the plan says so.

```sh
./install.sh --upgrade aws --shell bash --with mcp,aws-core --yes --claude-aws
```

A pin move is a change of `source.commit` of the six rows in `config/manifest.json`, by the pin rule of [the module versions](../../UPDATE.md#the-module-versions). The six rows must name one commit. Before a move, read the diff of the upstream repository: the skill lists, the hooks and the MCP entries. Then an upgrade moves the clone and the Claude Code plugins.

## The secret read guard

The kit extension `command-rules` denies the AWS CLI read of a Secrets Manager secret value, in Pi and in the Claude Code plugin `tenantext`. The read is `secretsmanager` with `get-secret-value` or `batch-get-secret-value`. The rule reads the shell words of each command, so quotes, backslashes and a backslash-newline line continuation do not hide a word.

- It accepts up to 12 options before the service and before the operation. An option can have one operand, also a quoted one, for example `--profile "my profile"`.
- It accepts an executable path, leading assignments, and up to three `sudo` or `env` prefixes with their options.
- It reads the script of `sh -c`, `bash -c`, `zsh -c`, `dash -c` and `ksh -c`, also with joined flags such as `-lc`, to a depth of three shells.

The rule is in each profile, with or without an AWS row: the rule table cannot depend on a module. It does not see an SDK call, a script file, `eval`, a command substitution (`$(...)`) or a variable that holds the command. It also does not see a command after a leading redirection (`2>file aws ...`), in a group (`(...)` or `{ ...; }`) or after `command`. In Claude Code, the hook of `aws-core` also covers SDK calls. Use the skill `aws-secrets-manager` for references that resolve at run time.

## Test against AWS Emulator

AWS Emulator serves AWS service APIs on one host, for one account (`000000000000`). Point the AWS CLI and the SDKs at it, not at a real account. The example uses the endpoint `https://emulator.example.internal`; use the endpoint of your emulator.

1. Copy the current credentials file of the emulator to the client, for example `~/.aws/emulator.credentials`, with mode `600`. The emulator makes new keys at each start.
2. Write a config file, for example `~/.aws/emulator.config`. S3 needs path-style addressing.

   ```ini
   [default]
   region = us-east-1
   s3 =
       addressing_style = path
       signature_version = s3v4
   ```

3. In the shell of the test, unset your real AWS credentials first. Then set the emulator variables.

   ```sh
   unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_MCP_PROXY_PROFILES
   export AWS_ENDPOINT_URL=https://emulator.example.internal
   export AWS_SHARED_CREDENTIALS_FILE="$HOME/.aws/emulator.credentials"
   export AWS_CONFIG_FILE="$HOME/.aws/emulator.config"
   export AWS_EC2_METADATA_DISABLED=true
   export AWS_DISABLE_HOST_PREFIX_INJECTION=true
   export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
   ```

4. Check the account. It must be `000000000000`.

   ```sh
   aws sts get-caller-identity --query Account --output text
   ```

5. Start Pi or Claude Code from that shell, and ask for one skill and one AWS CLI write and read, for example a bucket, an object and a list.

The kit launcher removes the emulator variables from the environment of `aws-mcp`. So the server stays unsigned and calls the AWS MCP endpoint, not the emulator. Use it for documentation search during an emulator test.

Warning: with `AWS_MCP_PROXY_PROFILES` set, the launcher keeps the emulator variables, and the proxy signs its calls to the AWS MCP endpoint with the emulator keys. Leave the variable unset for an emulator test.

## More AWS guidance

[AWS Builder Center](https://builder.aws.com/) has articles, examples and the community of AWS builders.

## Not verified

- A signed session of `aws-mcp`, in Pi or in Claude Code.
- A session of the real proxy through the kit launcher. The tests and the probes use a fake `uvx` that records its environment.
- A Claude Code session that calls a tool of the kit server. Verified only: `claude mcp list` with a fake `uvx` starts the kit server and not the servers of the plugins.
- A real AWS account with the skills or the server.
- macOS: no run of the AWS rows.
- Pi-Bolt: no run of the AWS rows.
- The adopt of a real user marketplace and of an installed plugin from another marketplace: only fakes in the tests.
- The texts of the skills: the diff from commit `26c84e3` to the pin was read for the plugin manifests, the skill lists, the hook and the MCP entries, not for each skill.
- The MCP servers of `aws-agents`, `aws-agents-for-devsecops` and the hooks, commands and agents of `aws-startup-advisor` in Claude Code.
