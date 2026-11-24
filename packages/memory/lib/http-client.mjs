// One outbound HTTP call with a deadline, no redirect and no proxy.
// The caller gives the headers, including any credential. The error never
// contains a header value or a response body.

import { SourceError } from './model.mjs';

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000, what = 'request' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new SourceError('timeout', `${what} took longer than ${timeoutMs} ms`, 504);
    throw new SourceError('unreachable', `${what}: the service is not reachable`, 502);
  }
  return readReply(res, what);
}

export async function readReply(res, what) {
  if (res.status === 401 || res.status === 403) {
    throw new SourceError('denied', `${what}: the service refused the credential (HTTP ${res.status})`, 502);
  }
  if (res.status === 404) throw new SourceError('not_found', `${what}: not found`, 404);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new SourceError('bad_reply', `${what}: the reply is not JSON (HTTP ${res.status})`, 502);
  }
  if (!res.ok) throw new SourceError('failed', `${what}: HTTP ${res.status}`, 502, json);
  return { status: res.status, headers: res.headers, json };
}
