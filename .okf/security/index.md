# Security

The pages of this group collect the controls that keep secrets and host values out of the published kit, keep private choices out of the clone, and limit what each identity of the shared memory can do. Each page summarizes; the two policy documents hold the full rules: [secret handling](../../docs/secret-handling.md) and [the shared memory security review](../../docs/shared-memory-security.md).

## Pages

- [The scan and the hooks](scan-and-hooks.md) - `scripts/scan.sh`, its findings, deny lists, levels and the Git hooks that run it.
- [The publish set and the public reader rules](publish-set.md) - which files a snapshot holds, and the content classes that the publish check refuses.
- [The private directory](private-directory.md) - where the private choices of a client live, and why the clone holds none of them.
- [The credentials of the modules](module-credentials.md) - what each module reads, sends and never stores, and why a profile is not a sandbox.
- [The shared memory security review](shared-memory-review.md) - the structure, the main controls and the open items of the security review of the shared memory.

## The rules in short

- No secret value enters a tracked file, an overlay, a generated profile, a log or a commit message.
- A host value stays in the untracked local deny list of that host and never in a tracked file.
- The scan runs before a commit, a merge and a push; a publication also runs it in full.
- The publish set is an explicit list; every other file stays private.
- Every identity of the shared memory holds only the actions and namespaces of its role, and no person deletes a record.
