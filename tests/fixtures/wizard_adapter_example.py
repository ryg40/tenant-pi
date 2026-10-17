"""Example adapter of the wizard seam: a small kit that sizes the profile of a model server.

A test fixture. It shows each part of the seam: its own catalog, one question of each type,
one added scan field (`extra.cards` from a fake probe) and its own plan rows with a refusal text.
"""
import copy

from scripts import wizard_adapter as seam

ROWS = [
    {"id": "runtime", "title": "Server runtime", "group": "core", "locked": True, "requires": [],
     "details": ["The server process of the kit."], "blocked": None, "defaultSelected": True},
    {"id": "profile", "title": "Measured profile", "group": "core", "locked": True, "requires": ["runtime"],
     "details": ["One profile with measured rules for the cards."], "blocked": None, "defaultSelected": True},
    {"id": "metrics", "title": "Metrics endpoint", "group": "optional", "subgroup": "Observability", "locked": False,
     "requires": ["runtime"], "details": ["A local metrics endpoint."], "blocked": None, "defaultSelected": False},
    {"id": "dashboard", "title": "Dashboard", "group": "optional", "subgroup": "Observability", "locked": False,
     "requires": ["metrics"], "details": ["A dashboard of the metrics."], "blocked": None, "defaultSelected": False},
    {"id": "cloud-sync", "title": "Cloud sync", "group": "optional", "locked": False, "requires": [],
     "details": ["Copies the profile to a remote store."], "blocked": "No reviewed source.", "defaultSelected": False},
]
# The memory of the weights in GiB for each quant, and the memory of 1,000 tokens of context in GiB.
WEIGHTS_GIB = {"q4": 18, "q6": 26, "q8": 34}
CONTEXT_GIB_PER_K = 0.125
RULE_SHAPE = [{"name": str, "minGiB": int}]


class ExampleKit(seam.Adapter):
    id = "example-kit"
    seam_version = seam.SEAM_VERSION
    scope = "Scan scope: a fake card probe and target absence. No live profile or vault contents."

    def catalog(self, context):
        return copy.deepcopy(ROWS)

    def cards(self):
        """The fake probe. A real kit reads its cards with seam.probe and a fixed command."""
        return [{"name": "fixture-card-a", "vramGiB": 24}, {"name": "fixture-card-b", "vramGiB": 16}]

    def scan(self, identity, context):
        found = {row["id"]: "missing" for row in ROWS}
        return seam.scan_fields(identity, found, runtime={}, extra={"cards": self.cards()})

    def questions(self, state, ask, show):
        show("Example kit questions. Only non-secret values.")
        seam.choice(ask, "quant", "Quant of the model", WEIGHTS_GIB, "q4")
        seam.text_if(ask, "dashboard" in state.selected, "dashboardName", "Name of the dashboard", "Fleet")
        ask("modelDir", "Model directory", state.identity["home"] + "/models", seam.absolute_path("wizard.modelDir"))
        ask("contextK", "Context in thousands of tokens (4 to 256)", "32", seam.integer(4, 256, "wizard.contextK"))
        ask("serverUrl", "Base URL of the server", "http://127.0.0.1:8080/v1", seam.url("wizard.serverUrl"))
        ask("keyVar", "Variable NAME of the server key; blank means none", "", seam.optional(seam.env_name("wizard.keyVar")))
        ask("rules", "Reserve rules JSON", '[{"name": "desktop", "minGiB": 2}]', seam.json_shape(RULE_SHAPE, "wizard.rules"))
        seam.consent(ask, "measure", "Permit a later measured run that loads the model?")

    def plan(self, state, scan):
        import json
        answers = state.answers
        cards = scan["extra"]["cards"] if scan else []
        rules = json.loads(answers["rules"])
        need = WEIGHTS_GIB[answers["quant"]] + int(answers["contextK"]) * CONTEXT_GIB_PER_K + sum(rule["minGiB"] for rule in rules)
        have = sum(card["vramGiB"] for card in cards)
        blocked = []
        if not scan:
            blocked.append("target_scan_required")
        elif not scan["targetAbsent"]:
            blocked.append("target_exists")
        refusal = None
        if have < need:
            blocked.append("vram_below_minimum")
            refusal = (f"The cards hold {have} GiB. This profile needs at least {need:g} GiB. "
                       "Choose a smaller quant or a smaller context.")
        asked = ["quant", "modelDir", "contextK", "serverUrl", "keyVar", "rules", "measure"]
        if "dashboard" in state.selected:
            asked.append("dashboardName")
        profile = {"quant": answers["quant"], "contextK": int(answers["contextK"]), "modelDir": answers["modelDir"],
                   "serverUrl": answers["serverUrl"], "keyVar": answers["keyVar"] or None,
                   "cards": cards, "reserve": rules, "measured": answers["measure"] == "yes",
                   "dashboard": answers.get("dashboardName") if "dashboard" in state.selected else None}
        return {"schemaVersion": 1, "identity": state.identity, "evidence": scan,
                "selection": state.selected, "dependenciesAdded": state.added,
                "answers": {key: answers[key] for key in asked},
                "overlayAfter": {"schemaVersion": 1, "target": state.identity["target"],
                                 "selection": state.selected, "profile": profile},
                "rows": [{"id": row["id"], "action": row["action"]} for row in state.rows() if row["marked"]],
                "needGiB": need, "haveGiB": have, "blocked": blocked, "refusal": refusal,
                "commandsRunnable": False, "permission": "save_only_not_installation"}


ADAPTER = ExampleKit()
