# tenant-design: Svelte

For Svelte 5 (runes) and SvelteKit. Facts were read on 2026-11-14 at npm, GitHub and the project sites. Check the site again before you state a version that is not written here.

## Core picks

| Task | Pick | Notes |
| --- | --- | --- |
| Styled components that the project owns, with Tailwind | shadcn-svelte https://www.shadcn-svelte.com | The shadcn/ui of Svelte. `npx shadcn-svelte@latest init`, then `npx shadcn-svelte@latest add <component>`. MIT, active. It builds on Bits UI. |
| Unstyled, accessible primitives (dialog, popover, menu, select, tabs, slider, tooltip) | Bits UI https://bits-ui.com | Package `bits-ui`. MIT, active, about 6 million downloads per month. The default for new work. |
| Toasts | svelte-sonner https://svelte-sonner.vercel.app | Package `svelte-sonner`. MIT, active. In a shadcn-svelte project: `add sonner`. |
| Drawers, bottom sheets (drag to dismiss, snap points) | Vaul Svelte https://github.com/huntabyte/vaul-svelte | Package `vaul-svelte`. The stable 0.3.2 is of 2024; the Svelte 5 line is the prerelease `1.0.0-next.7` of 2025-03: tell the user. In a shadcn-svelte project: `add drawer`. A side panel without drag needs only a Bits UI Dialog. |
| Command menu, Cmd+K | Command of Bits UI https://www.bits-ui.com/docs/components/command | No extra package. It replaces `cmdk-sv`, which is archived. |
| Animated numbers | NumberFlow https://number-flow.barvian.me/svelte/ | Package `@number-flow/svelte`. MIT. |
| Parts of an agent or chat UI (streaming messages, tool calls, reasoning, approvals) | AI Elements of shadcn-svelte https://www.shadcn-svelte.com/docs/ai-elements | Patterns that you copy, not a package. Add the base parts first: `npx shadcn-svelte@latest add trace code-block`. |
| Animation | Svelte built-ins first: transitions, `animate:flip`, `Spring`, `Tween` | No package. For gestures, interrupts, scroll-linked or layout animation add Motion https://motion.dev/docs/svelte (package `motion`, needs Svelte 5.29+). |
| Charts | LayerChart https://layerchart.com | Package `layerchart`, version 2 for Svelte 5. Version 1 is for Svelte 4. MIT, active. |
| Drag and drop | dnd kit for Svelte https://dndkit.com/svelte/quickstart/ | Package `@dnd-kit/svelte`, version 0.5.3, needs Svelte 5.29+. Young: before 1.0. |
| Long lists, virtualization | TanStack Virtual https://tanstack.com/virtual | Package `@tanstack/svelte-virtual`. Headless: the project writes the markup. No Svelte build of Virtuoso exists. |
| Shared state | Svelte 5 runes | No package. `$state` and `$derived` in a shared `.svelte.ts` module. Use a store only when an API needs the store contract. |
| Class names and variants | `clsx` and `tailwind-variants` | `tailwind-variants` takes the place of cva; shadcn-svelte uses it. |
| Dark mode without a flash | mode-watcher https://mode-watcher.sveco.dev | Package `mode-watcher`. MIT. Its last release is of 2025-06: tell the user. |
| One-time password input | Input OTP of shadcn-svelte | `npx shadcn-svelte@latest add input-otp`. It uses PinInput of Bits UI. |

## Alternatives

| Task | Library | When to choose it |
| --- | --- | --- |
| Styled components | Skeleton https://www.skeleton.dev (`@skeletonlabs/skeleton-svelte`) | The user wants a design system as a dependency, not copied source. Do not combine it with Flowbite Svelte or daisyUI. |
| Styled components | Flowbite Svelte https://flowbite-svelte.com (`flowbite-svelte`) | A large ready-styled Tailwind set. Its last release is of 2026-04. |
| Styled by classes only | daisyUI (`daisyui`) | A Tailwind plugin with class names, no Svelte components and no behavior. |
| Primitives | Ark UI https://ark-ui.com (`@ark-ui/svelte`) | The team uses Ark in other frameworks too. |
| Primitives | Melt https://next.melt-ui.com (`melt`) | The builder API of Melt. Not the legacy `@melt-ui/svelte`. |
| Animation | `@humanspeak/svelte-motion`, `motion-sv` | A declarative `motion.<tag>` API. Community projects; `motion-sv` also has copied components in the style of Magic UI. |
| Drag and drop | `svelte-dnd-action` | Only in a Svelte 3 or 4 project. Svelte 5 support is not verified. |

## Rules

1. Read `package.json` and `components.json` first. A listed library that the project has wins.
2. Check the Svelte version. These picks need Svelte 5. In a Svelte 4 project, say so, and pick the version line that supports it (LayerChart 1, `svelte-dnd-action`).
3. shadcn-svelte is the top layer and Bits UI sits below it. In a shadcn-svelte project, add the shadcn component first.
4. One primitives library per project. Do not add Ark UI or Melt beside Bits UI.
5. Do not use for new work: `cmdk-sv` (archived), `@melt-ui/svelte` (legacy line).
6. A simple hover, fade or list reorder needs no library: Svelte has transitions and `animate:flip`.

## Inspiration sources

The four sources of `SKILL.md`, part 2, ship React code. No official Svelte port of Magic UI, Aceternity UI or RareUI exists. Use them as visual references: name the effect, then build it again with Svelte transitions or Motion. `motion-sv` https://motion.hyprsonic.dev has community Svelte components in that style; read the source before use. The rules for inspiration of `SKILL.md` apply.
