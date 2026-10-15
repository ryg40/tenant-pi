# Shared memory

The pages of this group describe the shared AgentCore memory for several people. Start with the overview; it links to the other pages. The security review of the design is in [the security group](../security/shared-memory-review.md).

## Design

- [The shared memory in one page](overview.md) - one store, one IAM user per person, propose and review, and the example people.
- [The namespaces](namespaces.md) - the five namespace trees, who reads and writes each one, and the id rule.
- [The identities](identities.md) - the person user, the submit identity, the worker identity and the admin login, with their policy statements.
- [The review flow](review-flow.md) - propose, approve, reject and purge, with the confirmation and the private ledger.

## Packages

- [The shared memory core](core.md) - the one library of the design: config, namespace builder, recall, propose, review moves and the review CLI.
- [The AgentCore Pi extension](pi-extension.md) - recall before each typed prompt and the `agentcore_propose` tool in Pi.
- [The AgentCore Claude Code plugin](claude-code-plugin.md) - the `UserPromptSubmit` recall hook and the MCP server with the propose and review tools.
- [The AgentCore admin tool](admin-tool.md) - the registry script: provisioning, rotation, offboarding, purge and migration, with a dry run first.
