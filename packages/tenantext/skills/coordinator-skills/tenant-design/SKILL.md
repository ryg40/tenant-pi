---
name: tenant-design
description: Pick the library for each design component of a UI in React, Svelte or GPUI (Rust) - styled components, accessible primitives, toasts, drawers, command menus, animated numbers, agent and chat UI parts - and name inspiration sources for a style. Use when building or changing a React, Svelte or GPUI interface and a component needs a library (dialog, menu, select, toast, drawer, command palette, counter, chat or agent screen), when the user asks "which library for X", runs /tenant-design, asks for design options to pick from, mentions Apple Liquid Glass, or asks for a random or specific visual style, a landing-page effect or UI inspiration.
---

# tenant-design

Two functions. (1) Pick one library for a UI component. (2) Give inspiration sources when the user asks for a style.

Facts were checked on 2026-11-14 at each project site. On 2026-11-26 a second check read the licences of twelve sites only: shadcn/ui, Base UI, Radix, Sonner, Vaul, cmdk, NumberFlow, Beautiful UI, RareUI, Magic UI, Aceternity UI and 21st.dev. Check the site again before you state a version or a command that is not written here.

## 0. Find the stack

Read the project before you pick. The tables of this file are for React.

| The project has | Stack | Tier | Read |
| --- | --- | --- | --- |
| `react` in `package.json` | React | `web-react` | This file. |
| `svelte` in `package.json` | Svelte | `web-svelte` | `references/svelte.md` beside this file. Its tables replace the React tables. |
| `gpui`, `gpui-kit` or `gpui-component` in `Cargo.toml` | GPUI (Rust) | `gpui` | `references/gpui.md` beside this file. Its tables replace the React tables. |

With no project, use the stack that the user names; ask when the user names none. The steps of part 1 and the rules of part 2 apply to each stack.

Recall the tier of the stack from the OpenViking folder `viking://user/<user>/memories/preferences/tenant-design/<tier>/`, and read only that tier. `<user>` is the OpenViking user of the session. First search with the search tool of the OpenViking plugin (in Pi `openviking_search`): `query` = the task, `target_uri` = the tier folder, `mode` = `list`. Then read each returned file URI that fits with the read tool (in Pi `openviking_read`); `read` takes a file URI, not a folder. Three more tiers: `inspiration` for part 2, `apple-liquid-glass` when the user mentions Apple Liquid Glass, and `video` for the design of video output. The `README.md` of the folder lists the tiers. A dated preference in the OpenViking folder overrides a table of this skill when the two disagree. Without OpenViking, or with an empty tier, the tables of this skill are the rule.

## 1. Pick a library

1. Name the task, not the library. "A dropdown" is a primitives task.
2. Read `package.json` and `components.json` first. A listed library that the project has wins. When the project has a competitor, say the recommendation, and change the dependency only on the user's word.
3. Recommend one library, with one sentence of reason. Give a menu only when the user asks for options.
4. The stack is not React, Svelte or GPUI: say that the tables do not cover it, and pick from your own knowledge. Say that you left the list.
5. The task is not in the tables: say so, then pick from your own knowledge.

### Core picks

| Task | Pick | Notes |
| --- | --- | --- |
| Styled components for an app (buttons, forms, tables, dialogs, sidebar) with Tailwind | shadcn/ui https://ui.shadcn.com | Not an npm dependency: the CLI copies component source into the project, and the project owns it. `npx shadcn@latest init`, then `npx shadcn@latest add <component>`. New projects use Base UI primitives by default since July 2026; `init -b radix` selects Radix. |
| Unstyled, accessible primitives with an own visual design (dialog, popover, menu, select, tabs, slider, tooltip) | Base UI https://base-ui.com | Package `@base-ui/react`. From the makers of Radix, Material UI and Floating UI. The default for new work. |
| Primitives in a project that has Radix already | Radix https://www.radix-ui.com | Package `radix-ui` (one package) or `@radix-ui/react-*`. Keep it; do not migrate without the user's word. Do not start a new project on it. |
| Toasts, notifications | Sonner https://sonner.emilkowal.ski | Package `sonner`. One `<Toaster />`, then `toast()` from anywhere. |
| Drawers, bottom sheets (drag to dismiss, snap points) | Vaul https://vaul.emilkowal.ski | Package `vaul`. Its README says the repository is unmaintained: tell the user. A side panel without drag needs only a Base UI dialog. |
| Command menu, Cmd+K palette, searchable action list | cmdk https://cmdk.paco.me | Package `cmdk`. Unstyled; it filters and sorts the items. |
| Animated numbers (counters, prices, statistics) | NumberFlow https://number-flow.barvian.me | Package `@number-flow/react`; Vue, Svelte and plain TS/JS builds exist. |
| Parts of an agent or chat UI (streaming text, thinking state, tool chips, approval card, diff table, task rows) | Beautiful UI https://beautifului.dev | 22 components for AI-native screens, MIT. Its component sources import React hooks. Not verified: the install method. Read its docs before use. |

### How the picks fit together

- shadcn/ui is the top layer. Base UI or Radix sits below it. In a shadcn project, add the shadcn component first (`sonner`, `drawer`, `command`); it wraps the library of this table with the project's tokens.
- Use Base UI directly when the design is custom and shadcn styles would be removed anyway.
- One primitives library per project. Do not mix Base UI and Radix in new code.
- shadcn has an own Toast on Base UI since July 2026. A project that has it keeps it; else use Sonner.

### More picks

From the curated list of Emil Kowalski (`pick-ui-library`, MIT, https://github.com/emilkowalski/skills).

| Task | Pick |
| --- | --- |
| Animation with springs, layout, enter and exit, gestures | motion https://motion.dev (a hover or a fade needs only CSS transitions) |
| Animated text | torph https://torph.lochie.me |
| One-time password input | input-otp https://input-otp.rodz.dev |
| Control panel for tuning values | Leva https://github.com/pmndrs/leva |
| Charts | recharts https://recharts.org; live streaming charts: Liveline https://github.com/benjitaylor/liveline |
| Drag and drop | dnd kit https://dndkit.com |
| Long lists, large tables | Virtuoso https://virtuoso.dev |
| Shared state | zustand https://zustand.docs.pmnd.rs |
| Conditional class names | clsx; typed variants: cva https://cva.style |
| Dark mode without a flash | next-themes https://github.com/pacocoursey/next-themes |
| Syntax highlighting | shiki https://shiki.style |
| 3D globe | Cobe https://cobe.vercel.app |
| Open Graph images | Satori https://github.com/vercel/satori |

### Mismatches to catch

- A hand-made toast, or a toast made from a modal: use Sonner.
- A `<div>` dropdown or dialog with manual focus code: use Base UI.
- A number that changes by a plain text re-render, where motion matters: use NumberFlow.
- A hand-made Cmd+K list with an own filter: use cmdk.

## 2. Inspiration sources

Use this part only when the user asks for inspiration, a random style, a specific style, or an effect that the core picks do not have. Do not add these to an app UI unasked: they are heavy on motion and fit marketing pages more than tools.

| Source | Good for | Access |
| --- | --- | --- |
| Magic UI https://magicui.design | Polished landing-page motion: marquee, dock, animated beam, border beam, shimmer button, dot pattern, text animation, device mocks. | 150+ free components. shadcn CLI: `npx shadcn@latest add @magicui/<name>`. React, Tailwind, Motion. Pro is paid. |
| Aceternity UI https://ui.aceternity.com | Bold, dramatic effects: spotlight, lamp, background beams, sparkles, 3D card, parallax scroll, liquid glass, floating dock. | 118+ free components; copy-paste or shadcn CLI. React, Next.js, Tailwind, Motion. Blocks and templates are paid (Pro). |
| RareUI https://rareui.in | Motion-rich components with a premium look, when the two above look too common. | Free; full source goes into the project. React, Tailwind. The site now redirects to the same library under the name ShitUI (https://shitui.in). Its licence is MIT with the Commons Clause and an attribution term, not plain MIT: a visible credit and a link are required. Not verified: the install command. |
| 21st.dev https://21st.dev | The widest search: 12,000+ community components, heroes, pricing sections, testimonials, themes, shaders, gradients. | Free to browse, 2 free copies per day, then a membership. Each component has a shadcn CLI command. An MCP and a CLI for agents exist: https://21st.dev/mcp.md |

### Style to source

| The user asks for | Look first at |
| --- | --- |
| Clean, quiet, product-like | No inspiration source: shadcn/ui with own tokens |
| Polished SaaS landing page | Magic UI |
| Dark, glowing, dramatic, 3D | Aceternity UI |
| Something different, premium motion | RareUI |
| A specific section (hero, pricing, testimonial) or a shader | 21st.dev |
| Agent or chat product | Beautiful UI (core picks) |
| "Random" or "surprise me" | Choose one source, name two or three components from it that fit the page, and say why |

### Rules for inspiration

1. Suggest; do not install. Give the source, two or three named components and the link. Install after the user picks.
2. Read the component source before you add it: these are community code, not audited libraries. Check the license and the paid tier on its page.
3. Take one or two effects for a page. More makes the page slow and dated.
4. Keep the project's tokens: change the colors, radius and fonts of a copied component to match.
5. Respect `prefers-reduced-motion` for each added animation.
6. A component needs `motion` and Tailwind in most cases: check both before the add.

## Methods

| The task | Method |
| --- | --- |
| A library choice | The pick-ui-library method of Emil Kowalski, https://aiforui.dev/skills/pick-ui-library. Part 1 is the kit form of it, in the upstream order: the task, then the dependencies of the project, then one pick. Kit additions: `components.json` and the Svelte and GPUI tables. |
| Options of one design for the user to pick from | The prototype method, https://aiforui.dev/skills/prototype: working versions of one change, outside production code, each with a name, an axis and its cost. Kit adaptation: 2 or 3 versions, the number that Walkr Compare shows side by side; upstream defaults to three and allows up to five. Show them in Walkr Compare (the `walkr-compare` skill of the Walkr module); the user picks, and the agent integrates the pick only on the user's word. |
| The user mentions Apple Liquid Glass | The apple-design skill, https://aiforui.dev/skills/apple-design: translucent layers by material weight, no light glass on light glass, blur and scale together when a glass surface appears, and the reduced-motion, reduced-transparency and higher-contrast settings. |

## Arguments

- `/tenant-design` with no text: apply part 1 to the UI work of this session. With no UI work, ask what the user builds.
- `/tenant-design <component or task>`: pick for that task.
- `/tenant-design inspire <style>` or `random`: apply part 2.
