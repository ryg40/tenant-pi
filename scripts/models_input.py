"""Validated, non-secret direct-provider registrations. No host or network access."""
import copy
import re
from urllib.parse import urlsplit

from scripts.memory_modules import _embedding_url
from scripts.validate import ENV, fail, fields, text

FILE = "models.json"
SLOT = "inputs/models.json"
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}\Z")
PROVIDER_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")


def endpoint(value, at="models.provider.baseUrl"):
    _embedding_url(value, at)
    # No query, encoded characters, interpolation or credentials in a registration URL.
    if urlsplit(value).query or any(c in value for c in "%$?"):
        fail("credential_free_url", at)
    return value


def model(value):
    at = "models.provider.models.item"
    fields(value, ("id",), ("name", "contextWindow", "maxTokens", "reasoning", "input"), at)
    if type(value["id"]) is not str or not MODEL_ID.fullmatch(value["id"]):
        fail("model_id", at + ".id")
    if "name" in value:
        text(value["name"], at + ".name")
        if len(value["name"]) > 200:
            fail("text_too_long", at + ".name")
    for key in ("contextWindow", "maxTokens"):
        if key in value and (type(value[key]) is not int or not 1 <= value[key] <= 100000000):
            fail("positive_integer", at + "." + key)
    if "maxTokens" in value and "contextWindow" in value and value["maxTokens"] > value["contextWindow"]:
        fail("output_exceeds_context", at)
    if "reasoning" in value and type(value["reasoning"]) is not bool:
        fail("boolean", at + ".reasoning")
    if "input" in value and value["input"] not in (["text"], ["text", "image"]):
        fail("model_input", at + ".input")
    return value


def validate(data):
    fields(data, ("providers",), (), "models")
    providers = data["providers"]
    if type(providers) is not dict or not 1 <= len(providers) <= 32:
        fail("providers", "models.providers")
    for name, entry in providers.items():
        if type(name) is not str or not PROVIDER_ID.fullmatch(name):
            fail("provider_id", "models.providers")
        at = "models.provider"
        fields(entry, ("baseUrl", "api", "apiKey", "models"), (), at)
        endpoint(entry["baseUrl"])
        if entry["api"] != "openai-completions":
            fail("unsupported_api", at + ".api")
        key = entry["apiKey"]
        if type(key) is not str or (key != "none" and not re.fullmatch(r"\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})", key)):
            fail("env_reference_only", at + ".apiKey")
        items = entry["models"]
        if type(items) is not list or not 1 <= len(items) <= 128:
            fail("model_list", at + ".models")
        for item in items:
            model(item)
        if len({item["id"] for item in items}) != len(items):
            fail("duplicate_model", at + ".models")
    return copy.deepcopy(data)


def merge(data, name, base_url, model_id, key_var=None, metadata=None):
    """Update one explicit provider/model; retain other providers and other model entries."""
    result = validate(data) if data is not None else {"providers": {}}
    if type(name) is not str or not PROVIDER_ID.fullmatch(name):
        fail("provider_id", "models.providers")
    if key_var is not None and (type(key_var) is not str or not ENV.fullmatch(key_var)):
        fail("env_name", "models.auth")
    if metadata is not None and (type(metadata) is not dict or not set(metadata) <= {"name", "contextWindow", "maxTokens", "reasoning", "input"}):
        fail("metadata_fields", "models.metadata")
    item = {"id": model_id, **(metadata or {})}
    if item["id"] != model_id:
        fail("model_identity", "models.metadata")
    old = result["providers"].get(name, {})
    items = copy.deepcopy(old.get("models", []))
    for index, previous in enumerate(items):
        if previous["id"] == model_id:
            items[index] = {**previous, **item}
            break
    else:
        items.append(item)
    result["providers"][name] = {"baseUrl": base_url, "api": "openai-completions",
                                  "apiKey": "${" + key_var + "}" if key_var else "none", "models": items}
    return validate(result)
