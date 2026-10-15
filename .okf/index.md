---
okf_version: "0.2"
---
# The tenant-pi knowledge bundle

This bundle explains the tenant-pi kit to a human reader first and to an agent second. It is an Open Knowledge Format (OKF) v0.2 bundle: Markdown pages with YAML frontmatter. Each page summarizes one part of the kit and links to the repository document that holds the full facts.

The repository documents are the authority. When a page and its source document differ, the document is correct. The `sources` field of each page names the source documents and their paths.

## Maintenance

- The owner updates this bundle on an ad hoc request only.
- A release does not wait for the bundle.
- A stale page is not a defect of a release.
- No test, hook, check, gate or deploy step reads the bundle.
- The bundle is in the publish set, so the public reader rules of the publish check apply to each page.
- A page uses simple English: one idea per sentence, present tense, and "Not verified:" for a fact that no check proved.
- The examples use only the four fake people `alice`, `bruno`, `chen` and `dana`, the two fake projects `example-project` and `example-site`, and the placeholder memory id `mem-EXAMPLE`.

## Groups

- [The kit](kit/index.md) - the guided configuration kit, its command line, the profile plan, the private overlay and the architecture page.
- [Modules and packages](modules/index.md) - the memory modules, the workflow modules, the model routes and the in-tree packages.
- [Shared memory](shared-memory/index.md) - the shared AgentCore memory for several people: the design, the core, the namespaces, the identities, the review flow and the three packages around the core.
- [Maintenance flow](process/index.md) - the publishing flow and the snapshot, the release checklist and the issue tracker contract.
- [Security](security/index.md) - the scan and the hooks, the publish set and the public reader rules, the private directory, the credentials of the modules and the shared memory security review.

## Start here

- [The guided configuration kit](kit/kit.md) - what tenant-pi is, what it does and what it never does.
- [The shared memory in one page](shared-memory/overview.md) - the design of the shared AgentCore memory.
- [The security group](security/index.md) - the controls that keep secrets and host values out of the published kit.
