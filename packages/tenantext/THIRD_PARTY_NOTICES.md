# Third-party notices

## `@latentminds/pi-quotas`

The Codex limit parser and request shape in `extensions/codex-accounts/limits.ts` derive from the Codex-only implementation in `@latentminds/pi-quotas`.

- Project: https://github.com/latentminds-ai/pi-quotas
- Upstream version used as the fork base: `0.3.1`
- License: MIT
- Copyright: 2025-2026 Latent Minds Pty Ltd

The full upstream license text is in [`licenses/pi-quotas-MIT.txt`](licenses/pi-quotas-MIT.txt).

This repository does not depend on the upstream package. It intentionally omits all non-Codex quota providers and UI components.

## `mattpocock/skills`

The skill texts in `skills/coordinator-skills/` are adapted from the skills of `mattpocock/skills`. Each skill directory has a `CREDITS.md` with its upstream path.

- Project: https://github.com/mattpocock/skills
- Upstream version used as the base: `1.3.1`, commit `6fd9479`
- License: MIT
- Copyright: 2026 Matt Pocock

The full upstream license text is in [`licenses/mattpocock-skills-MIT.txt`](licenses/mattpocock-skills-MIT.txt).

This repository does not depend on the upstream package. It ships only the adapted skills that `skills/coordinator-skills/README.md` lists.

## `humanlayer/skills`

The skill text in `skills/coordinator-skills/show-me/` is adapted from the `show-me` skill of `humanlayer/skills`. The visual menu in `skills/coordinator-skills/pr/` comes from the same skill. The visual menu is the work of Dex Horthy.

- Project: https://github.com/humanlayer/skills
- Upstream path: `plugins/show-me`
- Upstream version used as the base: `1.0.1`, commit `ca7c808`
- License: MIT
- Copyright: 2026 HumanLayer

The full upstream license text is in [`licenses/humanlayer-skills-MIT.txt`](licenses/humanlayer-skills-MIT.txt).

This repository does not depend on the upstream package.
