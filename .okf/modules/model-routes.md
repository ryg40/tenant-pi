---
type: Data Contract
title: The model routes
description: The optional modelRoutes block chooses the models of a profile through a native, direct or gateway route; an explicit offline registry is the capability evidence, and no default model is chosen.
tags: [model-routes, gateway, registry, roles]
resource: ../../scripts/model_routes.py
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: model-routes
    resource: ../../docs/model-routes.md
    title: Pure model-route contract (docs/model-routes.md)
  - id: generator
    resource: ../../docs/generator.md
    title: The offline profile CLI (docs/generator.md)
  - id: providers
    resource: ../../docs/guides/providers.md
    title: The providers guide (docs/guides/providers.md)
---
# The model routes

A model route is the way a profile reaches a model. The kit selects no model by default. A route choice is offline data; it does not prove that a provider, a login or a model exists.

## The three routes

| Route | What it is |
| --- | --- |
| Native | A provider of Pi with Pi's own `/login`. Pi stores the result in its `auth.json`. |
| Direct | A direct inference server, for example llama-swap or vLLM, as a provider that the user registers in `models.json` of the profile. The kit writes no `models.json`. |
| Gateway | An optional gateway that forwards to an upstream provider. It needs the `codex-accounts` component. |

## The overlay block

The optional `modelRoutes` block has `schemaVersion: 1`, an explicit `cycle` of model choices and a `gateway` object or `null`. Each choice has separate `provider`, `model` and `thinking` strings. A slash in a model id is valid, and the kit never splits a combined string.

- To choose models, enable `core` and `model-routing`.
- A selected interactive role must be the first entry of the cycle. Another order fails with `interactive_not_first_in_cycle`.
- A required role without a selected model stays `required_missing`. No fallback is chosen.

## The registry

`--registry` names a JSON file of the form `{ "provider": { "model": ["thinkingLevel"] } }`. It is explicit offline capability evidence. It is not `models.json`, not authentication evidence and not a runtime catalog. A selected route model needs it.

## The gateway

- The endpoint is a credential-free HTTPS URL that ends exactly in `/v1`.
- The launch line sets `TENANTEXT_LITELLM_BASE_URL` for the one Pi process.
- With `auth: "env"`, the user supplies `TENANTEXT_LITELLM_API_KEY` to the same process. The overlay holds only the reference `${TENANTEXT_LITELLM_API_KEY}`.
- With `auth: "login"`, the plan reports `pi_login_blocked`, and `generate` refuses. A fresh profile cannot register the gateway provider through a URL-only login.

## Links

- [The profile plan](../kit/profile-plan.md)
- [The credentials of the modules](../security/module-credentials.md)
- Source documents: [the model-route contract](../../docs/model-routes.md), [the providers guide](../../docs/guides/providers.md)
