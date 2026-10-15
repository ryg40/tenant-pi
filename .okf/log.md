# Bundle update log

## 2026-10-15
* **Update**: Updated the [admin tool](shared-memory/admin-tool.md) page: every list names one exact namespace; the purge of a project lists the rejected namespace of each person of the registry, and the migration takes `--old-namespace` for a deeper old path. A failed delete with the error code 404 counts as done, because the list index lags behind a write.
* **Update**: Updated the [core](shared-memory/core.md) and the [Claude Code plugin](shared-memory/claude-code-plugin.md) pages: show, approve and reject take the proposer and list its one exact proposals namespace, because the live store reads the namespace of a list as an exact match.
* **Update**: Updated the pages of the [Pi extension](shared-memory/pi-extension.md), the [Claude Code plugin](shared-memory/claude-code-plugin.md), the [admin tool](shared-memory/admin-tool.md), the [core](shared-memory/core.md), the [memory modules](modules/memory-modules.md) and the [in-tree packages](modules/in-tree-packages.md) from the merged package sources. The admin tool now takes its registry functions from the core.
* **Creation**: Created the bundle with five groups: [the kit](kit/index.md), [modules and packages](modules/index.md), [shared memory](shared-memory/index.md), [maintenance flow](process/index.md) and [security](security/index.md).
* **Creation**: Wrote the shared memory pages from the core package and from the documents of the Pi extension, the Claude Code plugin and the admin tool.
