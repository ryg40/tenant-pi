import fs from "node:fs";
import { withFoot } from "./brand.js";

const modes = new Set(["core", "double", "coinflip", "trainer"]);

// Reserve only these exact shell routes, not arbitrary application URL prefixes.
export function modeForRoute(raw) {
  const prefix = "/_walkr/modes/";
  const mode = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
  return modes.has(mode) ? mode : null;
}

/**
 * How to start one mode, as static HTML. The mode pages and the empty view of the history page both show it.
 * `hosted` is true where the page cannot run the mode: the hosted server and the read-only mirror.
 */
export function modeGuidance(mode, { hosted = false } = {}) {
  const title = mode[0].toUpperCase() + mode.slice(1);
  return mode === "core"
    ? `<p>Launch name: <code>walkr-core</code>. The agent opens a page for review with <code>walkr-core &lt;file.html | file.md | http://localhost:port&gt;</code>.</p>
      <p>You comment and edit in the page, then send one batch to the chat. A Core page appears in this history after its first comment, edit or batch.</p>`
    : mode === "compare"
    ? `<p>Launch name: <code>walkr-compare</code>. An agent starts a session with <code>walkr-compare create</code> and 2 or 3 prepared options.</p>
      <p>${hosted ? "This read-only page shows the result. Pick, rate and submit on the Walkr page of the computer that made the session." : "<code>walkr-compare open</code> prints the private URL of this page. You pick one option, comment, submit and rate here."}</p>`
    : mode === "coinflip"
    ? `<p>Launch name: <code>walkr-coinflip</code>. Coinflip runs only in the local shared GUI. Hosted Coinflip is not available.</p>
      <p>${hosted ? "This hosted menu cannot run Coinflip." : "This menu cannot inspect your chat connection or recover a private GUI URL."}</p>
      <p>After separate approval, load <code>integrations/pi/shared-gui.ts</code> in the originating persistent Pi chat.
      Explicitly run <code>/shared-gui {&quot;action&quot;:&quot;connect&quot;}</code> there, open the returned private URL, select Coinflip, and send a brief.</p>
      <p>Each click saves a winner and requests one challenger. Stop freezes the latest winner; Submit returns it to the same chat.</p>
      <p>Use <code>walkr-coinflip --help</code> for agent commands. This page does not load extensions, start servers, launch chats, request inference, or reconnect.</p>`
    : mode === "double"
    ? `<p>Launch name: <code>walkr-double</code>. Double commands are local-only. Hosted Double is not available.</p>
      <p>${hosted ? "This hosted menu cannot run Double." : "This menu cannot inspect your chat connection or recover a private GUI URL."}</p>
      <p>Use <code>walkr-double --help</code> for the launch/connect boundary. The managed host command refuses execution.</p>
      <p>For approved local use, run <code>node /absolute/checkout/src/walkr-double.js --help</code>.
      Set an explicit absolute <code>HUMAN_REVIEW_STATE_DIR</code>. The archive is <code>~/.local/.walkr/double</code>, or <code>HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR</code> when you set it.</p>
      <p>After separate approval, load <code>integrations/pi/shared-gui.ts</code> in the originating persistent Pi chat.
      Explicitly run <code>/shared-gui {&quot;action&quot;:&quot;connect&quot;}</code> there and use its returned private URL.</p>
      <p>This page does not load extensions, start servers, launch chats, request inference, or reconnect.
      Connection status is unavailable here. Return to the same chat to reconnect explicitly.</p>`
    : mode === "trainer"
    ? `<p>Launch name: <code>walkr-trainer</code>. Trainer is local-only. Hosted Trainer is not available.</p>
      <p>The agent submits a prepared dataset with stable source IDs and a grouping plan of three-item groups.
      You review the plan, then rank each group 1, 2, 3 (1 is best) and use Save and Next. Leftover items stay unranked.</p>
      <p>${hosted ? "This hosted menu cannot run Trainer." : "This menu cannot list Trainer sessions or recover a private Trainer URL."}
      Ask the agent for <code>walkr-trainer open &lt;repo&gt; &lt;session-id&gt;</code>; it prints a new private URL.</p>
      <p>Datasets are saved under <code>~/.local/.walkr/trainer/&lt;repo-name&gt;/dataset/&lt;session-id&gt;</code>,
      or under <code>HUMAN_REVIEW_TRAINER_ROOT</code>. Votes are human ground truth; model analysis is stored separately.</p>
      <p>${hosted ? "The shared GUI is not available in hosted mode." : "You can also start Training from the local shared GUI prompt: select Training, enter a brief, and select Send. The connected chat prepares the dataset, and the ranking page appears in the GUI."}
      This page starts no server, chat, or inference.</p>`
    : `<p><code>walkr-${mode}</code>: not implemented. Execution returns a nonzero status; <code>--help</code> explains this limit.</p>
      <p>No generation, server, browser, or review-file access is available for ${title}.</p>
      <p>Use <code>walkr-core</code> for original review, or <code>walkr-double --help</code> or <code>walkr-coinflip --help</code> for local guidance.</p>`;
}

export function modePage(mode, { hosted = false } = {}) {
  const title = mode[0].toUpperCase() + mode.slice(1);
  const guidance = modeGuidance(mode, { hosted });
  return withFoot(fs.readFileSync(new URL("./mode-home.html", import.meta.url), "utf8"))
    .replaceAll("__MODE__", title).replace("__GUIDANCE__", guidance)
    .replace(`href="/_walkr/modes/${mode}"`, `href="/_walkr/modes/${mode}" aria-current="page"`);
}
