# Local workflow overrides

Promptr ships a fixed workflow matrix (the Generate Prompt role plan) with
neutral provider and model ids. A client machine retargets it by writing one
local JSON file. The file sets the provider, the model and the thinking level
per workflow level and role. No source edit and no second workflow engine.

This is what a GitHub Copilot-only client uses to run the same named workflow
templates on the models that machine actually has.

## Where the file lives

```
<PI_CODING_AGENT_DIR|~/.pi/agent>/promptr/workflows.json
```

`PROMPTR_WORKFLOWS_FILE=<absolute path>` selects a different file instead.

Precedence is deliberately short:

1. shipped defaults (`packages/promptr/src/workflow/catalog.mts`)
2. the single local override above

There is no implicit project-level override. The file is machine-local: it is
never written to `settings.json`, never committed by Promptr and never synced to
OpenKnowledge, so a machine's provider choice cannot leak into shared project
policy. It has no field that can hold a key, token or base URL — provider auth
stays entirely in Pi's own `auth.json` / `models.json`.

## Creating one

```bash
promptr-workflows-init --example copilot                                  # the packaged Copilot example
promptr-workflows-init --provider some-provider --all-pi                  # placeholders to fill in
promptr-workflows-init --example copilot --print                          # inspect the packaged example
promptr-workflows-init --provider some-provider --path /abs/file.json
```

The command writes exactly one JSON file and nothing else. It never starts an
agent, never logs in, never contacts a provider, and it cannot tell you a
provider works — the file it writes states intent. Availability is checked
separately, when a workflow is actually dispatched.

- An existing file is refused. `--force` is the explicit confirmation to
  overwrite it; `--print` shows the file without writing anything.
- `--all-pi` retargets the roles that ship on the Claude/Herdr route onto Pi
  sessions on the named provider. Without it, those roles keep their shipped
  route and the generated file writes them out verbatim.
- For a provider whose model IDs this machine cannot know, models are written as
  `<set-worker-model-id>`-style placeholders. Those are **rejected** until you
  replace them, so an unedited file blocks visibly instead of failing later with
  a confusing provider error. The command says `not usable yet` and exits 2.
- `--keep-models` keeps the shipped IDs instead. The shipped IDs are neutral tier names
  (`standard-model`, `light-model`, `large-model`), so use it only when your provider serves each exact ID.
  This flag does not translate model names. Confirm availability with `pi --list-models` after `/login`.

Packaged examples live in `packages/promptr/examples/`:

| File | What it shows |
| --- | --- |
| `workflows.example.json` | two sample providers and one template written out in full, easy to retune; the provider and model ids are sample values |
| `workflows.copilot.json` | GitHub Copilot only, every template all-Pi; confirm the example model IDs against your installed Pi catalog and subscription |

## Schema (version 1)

```jsonc
{
  "version": 1,
  "providers": ["github-copilot"],     // optional; the picker offers exactly these
  "defaultProvider": "github-copilot", // optional; must be in providers, listed first
  "workflows": {                        // optional; keys are shipped workflow IDs
    "worker-simple": {
      "label": "Copilot - simple",      // optional display label
      "description": "…",               // optional display description
      "roles": {                        // keys are roles that workflow actually has
        "worker": {
          "provider": "github-copilot", // optional; pins this role
          "model": "gpt-5.1-codex",     // optional; exact ID, no aliases
          "thinking": "medium",         // low | medium | high | xhigh
          "route": "pi"                 // pi | herdr-claude
        }
      }
    }
  }
}
```

Workflow IDs are the shipped ones: `worker-simple`, `worker-medium`,
`worker-high`, `reviewer-simple`, `reviewer`. Roles are `coordinator`, `scout`,
`researcher`, `worker`, `reviewer`, `generator`.

### Renamed template ids

The workflow IDs changed from provider names to role names. An override file
with an old key is a configuration error (unknown workflow). Edit each key by
hand:

| Old id | New id |
| --- | --- |
| `openai-codex-simple` | `worker-simple` |
| `openai-codex-medium` | `worker-medium` |
| `openai-codex-high` | `worker-high` |
| `openai-claude-simple` | `reviewer-simple` |
| `openai-claude` | `reviewer` |

The `worker-*` templates run every role as a Pi session. The `reviewer*`
templates run the worker and the reviewer on the `herdr-claude` route. The
shipped provider id is `default-provider`, and the shipped model ids are tier
names, not model IDs of a provider. An override file that relied on a shipped
provider or model id must now name its own in `providers` and in each role.

### What an override can and cannot do

- It **can** change a role's provider, model, thinking level and route, and a
  workflow's display label and description.
- It **cannot** add, drop or reorder roles, invent a workflow, or talk the
  `simple` template into accepting an unresolved design. Role order, the role
  set and the readiness rules still come from the shipped catalog.

### Precedence within a role

1. an explicit `provider` on the role wins
2. otherwise a role on the `pi` route uses the provider selected in the picker
3. a role on the `herdr-claude` route keeps its own provider

Provider-only remapping leaves model IDs untouched — nothing is aliased or
translated between providers. If you move roles to a provider that serves
different models, set `model` yourself. Changing `route` requires naming
`provider` in the same role: no provider is inherited across a route change.

### Errors are visible, never a silent fallback

Unknown keys, a wrong `version`, empty identifiers, duplicate providers, an
unsupported `thinking` or `route`, an unknown workflow or role name, a
`defaultProvider` outside `providers`, invalid JSON, and unreplaced
`<placeholder>` values are all configuration errors. When the file is invalid:

- the workflow picker offers no workflow and no provider,
- every expansion returns the configuration error, and
- the generator dispatch is blocked and says why.

The shipped defaults are **not** quietly substituted, because that would run a
matrix the operator did not choose. Delete the file to go back to defaults.

## Reload behaviour

The effective catalog is re-read at the workflow-open and dispatch boundaries,
not on every render. Edit the file, then reopen the workflow picker (companion:
open the tracking modal again; hosted `/promptr`: reopen the board flow) and the
new matrix is what you see. Once a preview is turned into a request packet, that
expansion is frozen into the packet and is what the preview, the deterministic
draft and the generator launch all use — a later edit does not retroactively
change an in-flight request.

## Runtime availability is separate

A preview is a static plan and says so. Nothing in this file proves a provider
is loaded, authenticated or serving a given model:

- `settings.json` `enabledModels` and subagent role configuration are selection
  hints, not proof of provider loading.
- The authoritative local answer is Pi's own registry (`pi --list-models`, or
  `ctx.modelRegistry` inside an extension). Use the exact IDs it reports.

The hosted extension runs inside Pi and reads that registry directly:

- `/promptr-workflows status` — the effective catalog (override path, valid or
  the exact error, workflows, providers).
- `/promptr-workflows check` — expands every workflow × provider of the
  effective catalog and reports each role as `ok`, `MISSING` (provider not
  loaded/authenticated, model not available, or thinking level unsupported) or
  `unverifiable` (Claude via Herdr is outside Pi's registry). Nothing is
  substituted; a missing role blocks a launch.
- `/promptr-workflows probe` — writes the capability probe
  `<PI_CODING_AGENT_DIR|~/.pi/agent>/promptr/capabilities.json` (or the absolute
  `PROMPTR_WORKFLOW_CAPABILITIES` path, also used by status/doctor/launch) from
  `modelRegistry.getAvailable()`: provider/model/thinking/route rows only, no
  key, token, header or base URL.
- Preparing a request in the hosted board also checks the frozen expansion and
  warns with the exact missing roles.

Promptr's companion runs outside Pi, so it cannot read the registry itself; its
generator dispatch reads the probe the hosted command wrote (or the file named
by `PROMPTR_WORKFLOW_CAPABILITIES`):

```json
{
  "version": 1,
  "writtenAt": "2030-09-08T10:00:00.000Z",
  "source": "pi modelRegistry.getAvailable()",
  "capabilities": [
    { "provider": "example-provider", "model": "example-model", "thinking": ["low", "medium", "high", "xhigh"], "route": "pi" }
  ]
}
```

Matching is exact on provider, model, route and thinking level. When a probe
exists and does not cover the role about to run, the dispatch is blocked before
any tab or agent is created. Configured workflows require a readable, valid
probe before launch. The shipped defaults do not launch: their provider and
model ids are neutral and no Pi serves them. Without an override file the
dispatch stops before any tab is created, with the reason `no workflow
override file`. An override file is the first step (`promptr-workflows-init`),
the probe is the second. `xhigh` requires an explicit
registry thinking-level mapping; malformed thinking entries invalidate the
whole probe rather than being silently filtered. A probe that is present but
unreadable or malformed blocks — absence of capabilities is never read as
support. `promptr-doctor` reports the probe's age and validity. Re-run the probe
after `/login` or model changes; it is not refreshed automatically.

## GitHub Copilot notes

- The provider ID is exactly `github-copilot` (Pi's built-in subscription
  provider). Log in with `/login` in Pi first; Promptr does not authenticate.
- The packaged example uses `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-6-astra` and the Claude IDs in its role entries.
  Check every ID with `pi --list-models` after `/login` before you use `--keep-models` or the example.
  Promptr never maps one provider's model name onto another's.
- The generator attaches no provider extension file. The Herdr state reporter
  (`herdr-agent-state.ts`) is still required for every Pi generator, because
  that is how Herdr learns the session's state.
- If you keep either `reviewer-simple` or `reviewer`, its worker and
  reviewer still run Claude through Herdr with their own permissions. Retarget
  them (as the packaged Copilot example does) if that machine has no Claude access.

## Provider quota fallback

Every expansion ends with two standing lines: the route summary and a `Provider quota fallback (pre-authorized):` line. The fallback names the next provider in picker order with the same model and thinking level, and it is the only runtime change a Coordinator may make without asking; it applies to usage-limit or quota errors on Pi-route roles only. An override recomputes that line from its own `providers` list, so a single-provider override yields an explicit "no fallback provider is configured" line rather than inheriting a shipped provider it never named.
