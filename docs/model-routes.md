# Pure model-route contract

This is an offline implementation contract, not a qualified runtime setup. `scripts/model_routes.py` neither reads files nor the environment, starts a process, or tests connectivity. The planner in `scripts/profile_plan.py` calls it; see `docs/profile-plan.md`. The existing core-only overlay stays valid without this extension. No defaults are selected.

## Client JSON v1

The optional top-level `modelRoutes` key has an independent `schemaVersion: 1`, an explicit `cycle` array of model choices, and a `gateway` object or `null`. Each choice has separate `provider`, `model`, and `thinking` strings and an optional `route` of `native` (default) or `gateway`. The same optional `route` is accepted on existing `roles.interactive`, `review`, `worker`, `research`, and `memory` objects only when `modelRoutes` exists. This keeps the legacy v1 overlay valid. The provider and model are never parsed from a combined string. A slash in a model ID is valid.

An illustrative synthetic shape, **not** a default or a working route:

```json
{
  "modelRoutes": {
    "schemaVersion": 1,
    "cycle": [
      {"provider": "fake-native", "model": "team/slash-id", "thinking": "high", "route": "native"}
    ],
    "gateway": null
  }
}
```

The rest of the overlay remains subject to `scripts/validate.py`. To choose models, enable both `core` and `model-routing`. To configure the gateway, also enable `codex-accounts`: this extension of `packages/tenantext` registers the gateway provider and reads the two `TENANTEXT_LITELLM_*` names. A non-null gateway is `{ "auth": "login" }` or `{ "auth": "env" }`. Set `endpoints.codex-accounts` to a credential-free HTTPS URL ending **exactly** in `/v1`; the renderer does not add or change prefixes. For environment-key auth, set `env.codex-accounts` to the literal `${TENANTEXT_LITELLM_API_KEY}`. For the source-declared Pi gateway login alternative, omit that mapping. This path has a fresh-profile bootstrap blocker; do not present it as working setup. Other endpoint/env keys are not supported by this pure extension. The old key `tenantext` fails with `moved_key`. A disabled gateway cannot have Tenantext endpoint/env fields or gateway choices. No endpoint or credential name is required for the core-only path.

This deliberately narrow endpoint rule rejects HTTP (including loopback), user information, query and fragment parts, shell syntax, escapes, and non-443 ports. The in-tree Tenantext package permits loopback HTTP, but the portable contract does not qualify local addresses. A different reviewed endpoint form needs a separate contract update. The URL is intended for a process-local `TENANTEXT_LITELLM_BASE_URL` assignment, **not** Pi settings interpolation. No resolved key enters the output.

## Python API

`render(overlay, registry, *, required_roles=(), credential_names=frozenset())` takes an in-memory validated overlay plus a synthetic registry shaped as `{provider: {model: [supportedThinkingLevels]}}`. It rechecks extension fields. The caller must still run `manifest(...)` and `overlay(...)` for the entire input. The registry is explicit mock capability evidence, not a live catalog or proof a route exists. Unsupported provider/model/thinking combinations fail with static `rule: field` diagnostics. The gateway path permits only the three aliases registered by pinned Tenantext: `litellm-codex` with `codex-auto/luna`, `codex-auto/sol`, or `codex-auto/astra`. Explicit `codex1/*` and `codex2/*` routes are not registered aliases. `openai-codex-2` requires Tenantext selection. Other native provider/model pairs need an explicit mock registry entry. A selected role or cycle model with a conflicting thinking level fails. Ambiguous combined `provider/model` settings keys and duplicate cycle models fail.

The returned JSON-compatible dictionary contains `settings`, `roles`, `cycle`, `roleStatus`, `requiredRoles`, `credentialNames`, `credentialStatus`, `setup`, and `availability: "unverified"`. `settings` is a contribution, not a complete Pi settings file. Only an interactive role sets `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. An explicit nonempty `cycle` sets `enabledModels` in input order. Observed with Pi 0.99.1 and 0.87.1: Pi starts on the first enabled model before the saved default. A selected interactive role must therefore be the first cycle entry; any other order fails with `interactive_not_first_in_cycle` and is never reordered. Selected role and cycle thinking levels set `modelThinkingLevels` by exact combined key. Unset roles remain `null` in `roles`; a name in `required_roles` becomes `required_missing`, with no fallback. `credential_names` are presence signals only; `name_supplied_unverified` does not mean the value is valid. For a configured gateway, `credentialNames` includes `TENANTEXT_LITELLM_BASE_URL` and includes `TENANTEXT_LITELLM_API_KEY` only for environment-key auth. `setup` carries a safely quoted process-local base-URL assignment plus a symbolic key name or a `pi_login_blocked` status for the stored-key option. Native selections get provider-specific Pi login guidance, without credential data. Authentication, upstream availability, capability metadata accuracy, and runtime status remain unverified.

## Source-backed mappings

These mappings use Pi 0.99.1 source observations. The kit pin is `runtime.piVersion` in `config/manifest.json`. Not verified: these runtime behaviours on the kit pin.

| Choice | Source observed with Pi 0.99.1 | Native destination and limit |
| --- | --- | --- |
| Interactive provider/model/thinking | Pi `docs/settings.md`, `docs/models.md` | `settings.json` `defaultProvider`, `defaultModel`, `defaultThinkingLevel`; separate model ID stays intact. |
| Explicit cycle | Pi `docs/settings.md#model-cycling`, `docs/models.md` | `settings.json` `enabledModels` uses `provider/modelId` patterns for cycling. No cycle is emitted when absent. |
| Model thinking | Pi `docs/settings.md` "Model and thinking" | `settings.json` `modelThinkingLevels` uses exact `provider/modelId` keys. Joined keys are checked for ambiguity. |
| Direct native auth | Pi `docs/providers.md`, `docs/configuration.md`, `docs/models.md` | Fresh `/login` belongs to Pi; Pi stores any result in its own `auth.json`. This kit writes no auth file. |
| Tenantext source and resource scope | `packages/tenantext/package.json`; Pi `docs/packages.md` | One local-path package declaration per package, with the filter of each enabled component. No copied provider extension. The planner owns activation. |
| Gateway URL and key | Same Tenantext pin `extensions/codex-accounts/routing.ts`, `docs/codex-routing.md` | `gatewayConfig` reads `TENANTEXT_LITELLM_BASE_URL` and optionally `TENANTEXT_LITELLM_API_KEY` from the process environment. Its base URL includes the gateway API prefix, usually `/v1`. Pinned source allows a previously stored Pi API key for `litellm-codex` instead of the env key, but a fresh login cannot bootstrap provider registration. See the blocker below. |
| Gateway aliases | Same Tenantext pin `extensions/codex-accounts/routing.ts` | `registerGateway` registers `litellm-codex`, `openai-completions`, and `codex-auto/{luna,sol,astra}` only when configuration and catalog permit. This contract does not build `models.json` or assert availability. |

**Fresh-login blocker:** In `packages/tenantext`, `extensions/codex-accounts/routing.ts:31-45` returns no gateway configuration without an existing key. Its `registerGateway` at lines 117-126 then skips provider registration. Observed with Pi 0.99.1: `dist/modes/interactive/interactive-mode.js:4721-4750` lists login choices only from registered providers. Lines 4762-4788 resolve `/login litellm-codex` from that same list. Therefore URL-only fresh-profile login cannot expose `litellm-codex`. This is not merely unverified availability. The `auth: "login"` choice stays visible as blocked contract data with `pi_login_blocked`, not as a runnable instruction. The environment-key bootstrap is a distinct supported offline setup route; its real connectivity remains unverified. Do not create auth files or copy credentials to work around this blocker.

Tenantext `docs/codex-routing.md` keeps direct OAuth providers separate from the gateway bearer credential. Its quota `tokenFile` path belongs to the process that refreshes the OAuth token. The kit does not read or render it, transfer OAuth refresh state, start another process that refreshes the same OAuth token, or generate `auth.json`. Pi `docs/models.md` describes `models.json` interpolation and command-backed keys, but this contract does not use those features. A configured URL is a process-local instruction, not a claim that arbitrary Pi fields expand `${...}`.

## Rules for a caller

1. Run the whole overlay validator before `render`. Supply an explicitly reviewed mock/qualified registry, required downstream role names, and only credential *names*. Do not use installed host catalog data.
2. Merge only declared model settings keys into `profile_plan.prepare`; preserve `enabledModels` and `modelThinkingLevels`. Inert role choices must remain private metadata. Do not silently choose a paid model for required roles.
3. Handle the process-local base URL instruction safely in display-only CLI output. Never execute or persist a resolved key. Use the symbolic environment-key route only for fresh profiles. Surface `pi_login_blocked` as a readiness gap until the upstream bootstrap path is fixed and reviewed.
4. Declare each in-tree package once, as a local path with the filter of each enabled component. The gateway needs the `codex-accounts` component. Preserve the native TUI and all existing disabled-module rules. Keep startup, auth, and connectivity checks pending a clean-client test with explicit consent.

Offline tests in `tests/test_model_routes.py` use synthetic endpoints and mock capabilities only. Do not treat a pure renderer result as a launchable profile.
