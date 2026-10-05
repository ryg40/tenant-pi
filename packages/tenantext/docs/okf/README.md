# Vendored Open Knowledge Format

This directory pins OKF v0.2 from the upstream repository and commit in `LOCK.json`.
The upstream files use the Apache License 2.0 in `LICENSE.md`.
To bump the pin:
1. Fetch `okf/SPEC.md` and `okf/LICENSE.md` from the new upstream commit.
2. Replace both vendored files without changing their bytes.
3. Rehash both files and update `LOCK.json`.
4. Commit the files and lock update together.
