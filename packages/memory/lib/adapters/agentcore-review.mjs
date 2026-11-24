// The one write of this app: the move of a proposed AgentCore record.
// A source has it only with an explicit `review` setting. `check-readonly.mjs`
// allows the update command in this file and in no other file.
//
// Approve moves /proposals/<developer>/<kind>/ to /shared/<developer>/<kind>/.
// Reject moves it to /rejected/<developer>/<kind>/. There is no other move,
// no text change and no delete.
import { BatchUpdateMemoryRecordsCommand, BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { SourceError } from '../model.mjs';

export const DECISIONS = { approve: 'shared', reject: 'rejected' };
const PROPOSAL = /^\/proposals\/([a-z0-9]{1,16})\/(preferences|entities|events)\/$/;

// The rail section of a namespace of the lean layout: what waits, what is approved, what is rejected.
const SECTIONS = { proposals: 'Waiting for approval', shared: 'Approved', rejected: 'Rejected' };
export const SECTION_ORDER = Object.values(SECTIONS);
export function sectionOf(namespace) {
  const match = /^\/(proposals|shared|rejected)\/[a-z0-9]{1,16}\/(?:preferences|entities|events)\/$/.exec(String(namespace));
  return match ? SECTIONS[match[1]] : null;
}

// The target namespace of a decision, or null when the namespace is no proposal namespace.
export function targetOf(namespace, decision) {
  const match = PROPOSAL.exec(String(namespace));
  return match && Object.hasOwn(DECISIONS, decision) ? `/${DECISIONS[decision]}/${match[1]}/${match[2]}/` : null;
}

export function createReviewer(cfg, { clientFactory, now = Date.now } = {}) {
  const review = cfg.review;
  if (!review || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some((key) => key !== 'profile')
      || typeof review.profile !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(review.profile) || review.profile === cfg.profile) {
    throw new SourceError('config', 'A review source needs its own reviewer profile.', 503);
  }
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  let client;
  return {
    async move(record, from, to) {
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new SourceError('timeout', 'The record move exceeded its deadline.', 504));
          controller.abort();
        }, timeoutMs);
      });
      let out;
      try {
        out = await Promise.race([deadline, Promise.resolve().then(() => {
          if (!client) {
            // Only the named reviewer profile. A failed profile never selects host credentials.
            const options = {
              region: cfg.region, profile: review.profile, credentials: fromIni({ profile: review.profile }),
              maxAttempts: 1, ignoreConfiguredEndpointUrls: true,
            };
            client = clientFactory ? clientFactory(cfg, options) : new BedrockAgentCoreClient(options);
          }
          return client.send(new BatchUpdateMemoryRecordsCommand({
            memoryId: cfg.memoryId,
            records: [{
              memoryRecordId: record.memoryRecordId,
              // The event time of the record stays; the move is not a new event.
              timestamp: record.timestamp instanceof Date ? record.timestamp : new Date(now()),
              namespaces: [to], sourceNamespaces: [from],
            }],
          }), { abortSignal: controller.signal });
        })]);
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (error?.name === 'AccessDeniedException' || error?.$metadata?.httpStatusCode === 403) {
          throw new SourceError('review_denied', 'The service denied the record move.', 403);
        }
        if (error?.name === 'CredentialsProviderError') {
          throw new SourceError('credentials', 'The reviewer profile has no usable credential.');
        }
        throw new SourceError('review_failed', 'The record move failed.');
      } finally {
        clearTimeout(timer);
      }
      const done = Array.isArray(out?.successfulRecords) ? out.successfulRecords : [];
      const failed = Array.isArray(out?.failedRecords) ? out.failedRecords : [];
      if (failed.length || done.length !== 1 || done[0]?.memoryRecordId !== record.memoryRecordId) {
        throw new SourceError('review_failed', 'The record move failed.');
      }
    },
  };
}
