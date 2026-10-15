// Memory records: list by the request field `namespace`, delete and move in batches of 100.
// Every call goes through `client.send(name, input)`, so a test gives a fake client.

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

/** Every record whose namespace starts with `namespace` (the API describes the field as a prefix). */
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

/** True when every namespace of the record lies under one of the prefixes. */
export const within = (record, prefixes) =>
  record.namespaces.length > 0 && record.namespaces.every((ns) => prefixes.some((prefix) => ns.startsWith(prefix)));

function chunks(items) {
  const result = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) result.push(items.slice(start, start + BATCH_SIZE));
  return result;
}

/** Delete records in batches of 100. Each record names the namespace that the list found it in. Stops on a failed record. */
export async function deleteRecords(client, memoryId, records) {
  let deleted = 0;
  for (const batch of chunks(records)) {
    const result = await client.send("BatchDeleteMemoryRecords", { memoryId,
      records: batch.map((record) => ({ memoryRecordId: record.memoryRecordId, namespace: record.namespace })) });
    deleted += result.successfulRecords?.length ?? 0;
    if (result.failedRecords?.length) {
      throw new Error(`${result.failedRecords.length} record delete(s) failed after ${deleted} deleted; run the step again`);
    }
  }
  return deleted;
}

/** Move records with `BatchUpdateMemoryRecords` in batches of 100: `sourceNamespaces` the old namespace, `namespaces` the new one.
 * A move keeps the record id; the request has no `content`. Stops on a failed record. */
export async function moveRecords(client, memoryId, moves) {
  let moved = 0;
  for (const batch of chunks(moves)) {
    const result = await client.send("BatchUpdateMemoryRecords", { memoryId, records: batch });
    moved += result.successfulRecords?.length ?? 0;
    if (result.failedRecords?.length) {
      throw new Error(`${result.failedRecords.length} record move(s) failed after ${moved} moved; run the step again`);
    }
  }
  return moved;
}
