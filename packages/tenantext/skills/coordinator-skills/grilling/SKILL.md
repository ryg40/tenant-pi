---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the frontier in rounds of **three questions**: number each question and give your recommended answer first. Then wait for the user's answers before the next round. When the frontier holds more than three questions, ask the three with the most decisions downstream of them, and keep the rest for the next round.

## How to ask, by harness

- **Claude Code**: use the `AskUserQuestion` tool, one call with up to three questions. Each question has 2 to 4 options with a description. Put the recommended option first and add "(Recommended)" to its label.
- **Pi**: use the `ask_user_question` tool (extension `@juicesharp/rpiv-ask-user-question`), one call with up to three questions, the same option rules. Its guidelines come from `~/.config/rpiv-ask-user-question/config.json`.
- **No question tool** (the tool is absent, the run is not interactive, or the call returns `no_ui`): ask in plain text, in this form, with no emoji:

```
Q1 - <question title>: <question body, with the choices>

Recommended: <your recommended answer>

---

Q2 - <question title>: <question body, with the choices>

Recommended: <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, memory, the tracker), look it up yourself when it is one command or one read. When it is a search, do this. Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Start a Herdr `scout` pane and ask it. Use a Herdr pane for each search. Don't block on it: a running lookup is an unsettled prerequisite, so only the questions downstream of it wait for the result; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

Record each settled decision where the work lives: the ticket comment and the map's "Decisions so far" for a Wayfinder ticket; OpenViking `remember` only for a standing preference of the user.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
