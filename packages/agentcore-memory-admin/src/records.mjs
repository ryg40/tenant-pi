// Memory records: list one exact namespace by the request field `namespace`, delete and move in batches of 100.
// Every call goes through `client.send(name, input)`, so a test gives a fake client.
// The live store reads the request field `namespace` of `ListMemoryRecords` as an exact match, while the
// API reference describes a prefix (live proof of 2026-10-15). So every list names one exact namespace.

export const BATCH_SIZE = 100;
const PAGE_SIZE = 100;

export async function createMemoryClient(profile, region) {
  const sdk = await import("@aws-sdk/client-bedrock-agentcore");
  const client = new sdk.BedrockAgentCoreClient({ region, profile, maxAttempts: 2 });
  return {
    send: (name, input) => client.send(new sdk[`${name}Command`](input)),
    destroy: () => client.destroy(),
  };
}

/** The text of the list form in a dry run. */
export const LIST_FORM = "request field namespace, exact form";

/** Every record of the one exact namespace `namespace`. A list of a tree prefix gets no record from the live store. */
export async function listRecords(client, memoryId, namespace) {
  const records = [];
  let nextToken;
  do {
    const page = await client.send("ListMemoryRecords", { memoryId, namespace, maxResults: PAGE_SIZE,
      ...(nextToken ? { nextToken } : {}) });
    for (const item of page.memoryRecordSummaries ?? []) {
      if (typeof item.memoryRecordId !== "string") continue;
      records.push({
        memoryRecordId: item.memoryRecordId,
        namespaces: Array.isArray(item.namespaces) ? item.namespaces : [],
        text: item.content?.text,
        createdAt: item.createdAt,
        metadata: item.metadata ?? {},
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return records;
}

/** List each exact namespace. A record appears once, with `listed` the first namespace that returned it.
 * `counts` holds the number of records of each list, in the order of `namespaces`. */
export async function listNamespaces(client, memoryId, namespaces) {
  const found = new Map();
  const counts = [];
  for (const namespace of namespaces) {
    const records = await listRecords(client, memoryId, namespace);
    counts.push({ namespace, count: records.length });
    for (const record of records) if (!found.has(record.memoryRecordId)) found.set(record.memoryRecordId, { ...record, listed: namespace });
  }
  return { records: [...found.values()], counts };
}

/** The dry-run lines of the lists: the namespaces to list, or, after the lists, each namespace with its count. */
export function namespaceLines(namespaces, counts = null) {
  if (!counts) return ["namespaces to list (exact form):", ...namespaces.map((namespace) => `  ${namespace}`)];
  return ["namespaces listed (exact form):", ...counts.map(({ namespace, count }) => `  ${namespace} ${count} record(s)`)];
}

/** True when every namespace of the record lies under one of the prefixes. A filter of listed records only. */
export const within = (record, prefixes) =>
  record.namespaces.length > 0 && record.namespaces.every((ns) => prefixes.some((prefix) => ns.startsWith(prefix)));

function chunks(items) {
  const result = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) result.push(items.slice(start, start + BATCH_SIZE));
  return result;
}

// The service model gives the `errorCode` of a failed record as an integer and lists no values. Its one error
// for a record that does not exist, `ResourceNotFoundException`, has the HTTP status 404 ("a resource that has
// been deleted"). So a failed delete with `errorCode` 404 means that the record is gone: it counts as done.
export const GONE = 404;
const MESSAGE_LENGTH = 200;

/** The dry-run line of the list index. In the live proof of 2026-10-15 the index lagged one to five minutes behind a write. */
export const LAG_LINE = "list index: it lags one to five minutes behind a write; a record that a step deleted or moved "
  + "in that time can still be listed";

/** One line for each failed record: the id, the error code and the message. The message loses its control characters. */
function failureLines(failed) {
  return failed.map((item) => {
    const code = Number.isInteger(item.errorCode) ? item.errorCode : "none";
    const text = typeof item.errorMessage === "string" && item.errorMessage
      ? item.errorMessage.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, MESSAGE_LENGTH) : "no message";
    return `  ${item.memoryRecordId ?? "?"}: error code ${code}: ${text}`;
  });
}

/** The apply line for the deletes that found the record gone, or no line. */
export const goneLines = ({ gone }) => (gone ? [`${gone} record(s) were gone already (error code ${GONE}); counted as done`] : []);

/** Delete records in batches of 100. Each record names the namespace that the list found it in.
 * A record that is gone (error code 404) counts as done: the list index lags behind a delete.
 * Any other failed record stops the step; the error names the code and the message of each failed record. */
export async function deleteRecords(client, memoryId, records) {
  let deleted = 0, gone = 0;
  for (const batch of chunks(records)) {
    const result = await client.send("BatchDeleteMemoryRecords", { memoryId,
      records: batch.map((record) => ({ memoryRecordId: record.memoryRecordId, namespace: record.namespace })) });
    deleted += result.successfulRecords?.length ?? 0;
    const failed = result.failedRecords ?? [];
    gone += failed.filter((item) => item.errorCode === GONE).length;
    const stopped = failed.filter((item) => item.errorCode !== GONE);
    if (stopped.length) {
      const done = gone ? `${deleted} deleted and ${gone} gone already` : `${deleted} deleted`;
      throw new Error([`${stopped.length} record delete(s) failed after ${done}; run the step again`, ...failureLines(stopped)].join("\n"));
    }
  }
  return { deleted, gone };
}

/** Move records with `BatchUpdateMemoryRecords` in batches of 100: `sourceNamespaces` the old namespace, `namespaces` the new one.
 * A move keeps the record id; the request has no `content`. Stops on a failed record and names its code and message. */
export async function moveRecords(client, memoryId, moves) {
  let moved = 0;
  for (const batch of chunks(moves)) {
    const result = await client.send("BatchUpdateMemoryRecords", { memoryId, records: batch });
    moved += result.successfulRecords?.length ?? 0;
    if (result.failedRecords?.length) {
      throw new Error([`${result.failedRecords.length} record move(s) failed after ${moved} moved; run the step again`,
        ...failureLines(result.failedRecords)].join("\n"));
    }
  }
  return moved;
}
