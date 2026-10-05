"""Pure, bounded Pi model-route contributions from client-owned choices."""
import copy
import re
import shlex

from scripts.validate import ROLE_NAMES, ENV, fields, fail, text, url

THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:-]*\Z")
ALIASES = frozenset(("codex-auto/luna", "codex-auto/sol", "codex-auto/astra"))
BASE_NAME = "TENANTEXT_LITELLM_BASE_URL"
KEY_NAME = "TENANTEXT_LITELLM_API_KEY"


def _choice(value, at):
    fields(value, ("provider", "model", "thinking"), ("route",), at)
    for key in ("provider", "model"):
        text(value[key], at + "." + key)
        if not ID.fullmatch(value[key]):
            fail("model_id", at + "." + key)
    if type(value["thinking"]) is not str or value["thinking"] not in THINKING:
        fail("thinking", at + ".thinking")
    if "route" in value and (type(value["route"]) is not str or value["route"] not in ("native", "gateway")):
        fail("route", at + ".route")


def validate_choices(overlay):
    """Validate only the optional v1 extension; the core overlay validator owns the rest."""
    routes = overlay["modelRoutes"]
    fields(routes, ("schemaVersion", "cycle", "gateway"), (), "overlay.modelRoutes")
    if type(routes["schemaVersion"]) is not int or routes["schemaVersion"] != 1:
        fail("schema_version", "overlay.modelRoutes.schemaVersion")
    if type(routes["cycle"]) is not list:
        fail("array", "overlay.modelRoutes.cycle")
    for choice in routes["cycle"]:
        _choice(choice, "overlay.modelRoutes.cycle.entry")
    gateway = routes["gateway"]
    if set(overlay["endpoints"]) - {"codex-accounts"} or set(overlay["env"]) - {"codex-accounts"}:
        fail("unsupported_route_field", "overlay.modelRoutes")
    if gateway is not None:
        fields(gateway, ("auth",), (), "overlay.modelRoutes.gateway")
        if type(gateway["auth"]) is not str or gateway["auth"] not in ("login", "env"):
            fail("gateway_auth", "overlay.modelRoutes.gateway.auth")
    enabled = set(overlay["selection"]["enable"])
    choices = [value for value in overlay["roles"].values() if value is not None] + routes["cycle"]
    for choice in choices:
        _choice(choice, "overlay.modelRoutes.choice")
    if choices and "model-routing" not in enabled:
        fail("model_routing_required", "overlay.modelRoutes")
    if (gateway is not None or any(value.get("route", "native") == "gateway" for value in choices)) and "codex-accounts" not in enabled:
        fail("gateway_disabled", "overlay.modelRoutes.gateway")
    if any(value.get("route", "native") == "gateway" for value in choices) and gateway is None:
        fail("gateway_missing", "overlay.modelRoutes.gateway")
    if gateway is None and ("codex-accounts" in overlay["endpoints"] or "codex-accounts" in overlay["env"]):
        fail("gateway_disabled", "overlay.modelRoutes.gateway")
    if gateway is not None and "model-routing" not in enabled:
        fail("model_routing_required", "overlay.modelRoutes.gateway")
    if gateway is not None:
        base = overlay["endpoints"].get("codex-accounts")
        if base is None:
            fail("gateway_endpoint_missing", "overlay.endpoints.codex-accounts")
        url(base, "overlay.endpoints.codex-accounts")
        if not base.endswith("/v1"):
            fail("gateway_api_prefix", "overlay.endpoints.codex-accounts")
        ref = overlay["env"].get("codex-accounts")
        if gateway["auth"] == "env" and ref != "${" + KEY_NAME + "}":
            fail("gateway_env_name", "overlay.env.codex-accounts")
        if gateway["auth"] == "login" and ref is not None:
            fail("gateway_auth_conflict", "overlay.env.codex-accounts")
    # Exact Pi provider/model keys cannot represent two different tuples with the same join.
    keys = {}
    for value in choices:
        key = value["provider"] + "/" + value["model"]
        pair = (value["provider"], value["model"])
        if key in keys and keys[key] != pair:
            fail("ambiguous_model_key", "overlay.modelRoutes")
        keys[key] = pair
    if len({(v["provider"], v["model"]) for v in routes["cycle"]}) != len(routes["cycle"]):
        fail("duplicate_cycle_model", "overlay.modelRoutes.cycle")


def render(overlay, registry, *, required_roles=(), credential_names=frozenset()):
    """Return JSON-compatible contributions and setup facts. No file, environment, or subprocess reads."""
    if "modelRoutes" not in overlay:
        fail("required_fields", "overlay.modelRoutes")
    validate_choices(overlay)
    if type(registry) is not dict:
        fail("mock_registry", "registry")
    for provider, models in registry.items():
        if type(provider) is not str or not ID.fullmatch(provider) or type(models) is not dict:
            fail("mock_registry", "registry")
        for model, levels in models.items():
            if (type(model) is not str or not ID.fullmatch(model) or type(levels) is not list
                    or not levels or any(type(level) is not str or level not in THINKING for level in levels)
                    or len(levels) != len(set(levels))):
                fail("mock_registry", "registry")
    if (type(required_roles) not in (tuple, list) or any(type(r) is not str or r not in ROLE_NAMES for r in required_roles)
            or len(set(required_roles)) != len(required_roles)):
        fail("required_roles", "required_roles")
    if type(credential_names) not in (set, frozenset) or any(type(n) is not str or not ENV.fullmatch(n) for n in credential_names):
        fail("credential_names", "credential_names")
    gateway_auth = overlay["modelRoutes"]["gateway"]
    allowed_names = ({BASE_NAME, KEY_NAME} if gateway_auth["auth"] == "env" else {BASE_NAME}) if gateway_auth else set()
    if not set(credential_names) <= allowed_names:
        fail("credential_names", "credential_names")
    roles = overlay["roles"]
    cycle = overlay["modelRoutes"]["cycle"]
    gateway = overlay["modelRoutes"]["gateway"]
    for value in [v for v in roles.values() if v is not None] + cycle:
        at = "overlay.modelRoutes.choice"
        route = value.get("route", "native")
        if route == "gateway":
            if value["provider"] != "litellm-codex" or value["model"] not in ALIASES:
                fail("unsupported_gateway_model", at)
        else:
            if value["provider"] == "litellm-codex":
                fail("unsupported_native_provider", at)
            if value["provider"] == "openai-codex-2" and "codex-accounts" not in overlay["selection"]["enable"]:
                fail("provider_requires_codex_accounts", at)
        if value["thinking"] not in registry.get(value["provider"], {}).get(value["model"], ()):
            fail("unsupported_model_thinking", at)
    levels = {}
    for value in [v for v in roles.values() if v is not None] + cycle:
        key = value["provider"] + "/" + value["model"]
        if key in levels and levels[key] != value["thinking"]:
            fail("conflicting_model_thinking", "overlay.modelRoutes")
        levels[key] = value["thinking"]
    settings = {}
    interactive = roles.get("interactive")
    # Pi starts on the first scoped (enabled) model before its saved default; never emit a contradictory pair.
    if interactive and cycle and (cycle[0]["provider"], cycle[0]["model"]) != (interactive["provider"], interactive["model"]):
        fail("interactive_not_first_in_cycle", "overlay.modelRoutes.cycle")
    if interactive:
        settings.update(defaultProvider=interactive["provider"], defaultModel=interactive["model"],
                        defaultThinkingLevel=interactive["thinking"])
    if cycle:
        settings["enabledModels"] = [v["provider"] + "/" + v["model"] for v in cycle]
    if levels:
        settings["modelThinkingLevels"] = dict(sorted(levels.items()))
    required = sorted(set(required_roles))
    statuses = {name: "selected" if roles.get(name) is not None else "required_missing" if name in required else "unset"
                for name in ROLE_NAMES}
    setup = [{"kind": "native_auth", "provider": provider, "method": "pi_login", "state": "unverified"}
             for provider in sorted({v["provider"] for v in [r for r in roles.values() if r is not None] + cycle
                                     if v.get("route", "native") == "native"})]
    names = []
    if gateway:
        names.append(BASE_NAME)
        if gateway["auth"] == "env":
            names.append(KEY_NAME)
        # The URL is public configuration data, not a key. Never include a secret in this instruction.
        setup.append({"kind": "process_environment", "name": BASE_NAME,
                      "instruction": BASE_NAME + "=" + shlex.quote(overlay["endpoints"]["codex-accounts"])})
        setup.append({"kind": "gateway_auth", "method": "pi_login_blocked" if gateway["auth"] == "login" else "process_environment",
                      "provider": "litellm-codex", "name": KEY_NAME if gateway["auth"] == "env" else None})
    return {"settings": settings, "roles": copy.deepcopy({name: roles.get(name) for name in ROLE_NAMES}),
            "cycle": copy.deepcopy(cycle), "roleStatus": statuses, "requiredRoles": required, "credentialNames": names,
            "credentialStatus": {name: "name_supplied_unverified" if name in credential_names else "missing"
                                 for name in names}, "setup": setup, "availability": "unverified"}
