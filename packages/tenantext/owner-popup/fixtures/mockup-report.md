Quota footer fix is ready; branch topic/quota-footer passes all 42 fast checks (2.9 s), and the protected macOS runner went offline at 06:58 UTC.

## Checks

1. `npm test` on topic/quota-footer (exit 0)
```text
pass 42
fail 0
```

## Next

- **[A]** Agent: Update release notes once release scope is picked.
- **[B]** Owner decides: How the footer shows the quota: as a percent, or as a bar.
- **[C]** Owner decides: Merge the fix into main and push, or hold it for one more review.
- **[D]** Owner decides: What the next release must hold.
- **[E]** Owner: Start the protected macOS runner again.
