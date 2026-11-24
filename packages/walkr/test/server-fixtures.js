import http from "node:http";

export function request(port, route, { token, method = "GET", body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: {
      ...(token ? { "x-human-review-token": token } : {}),
      ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on("data", (bytes) => chunks.push(bytes));
      res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text, json });
      });
    });
    req.on("error", reject);
    req.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

// The server resolves its state path at each save, not once, so the variables of listen() stay set until the last open
// server closes. Then each variable gets the value that it had before the first open server. While a server is open,
// process.env holds the fixture values: pass a variable through the env argument of listen(), not with a save and restore of
// your own, because such a restore runs after the close and writes the fixture value back.
let openServers = 0, outerEnv = {};
function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(outerEnv, key)) outerEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
function restoreEnv() {
  if (--openServers > 0) return;
  for (const [key, value] of Object.entries(outerEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  outerEnv = {};
}

export async function listen(t, f, env = {}) {
  openServers += 1;
  setEnv({ HUMAN_REVIEW_STATE_DIR: f.stateDir, HUMAN_REVIEW_HOSTED: undefined, ...env });
  let service;
  // Track each request handler; a closed connection does not end a handler that is still writing.
  const handling = new Set();
  try {
    const { createServer } = await import("../src/server.js");
    service = createServer();
    const [handler] = service.server.listeners("request");
    service.server.removeListener("request", handler);
    service.server.on("request", (req, res) => {
      const work = Promise.allSettled([handler(req, res)]);
      handling.add(work);
      work.then(() => handling.delete(work));
    });
    await new Promise((resolve, reject) => { service.server.once("error", reject); service.server.listen(0, "127.0.0.1", resolve); });
  } catch (error) {
    service?.dispose();
    restoreEnv();
    throw error;
  }
  const port = service.server.address().port;
  let closed;
  const close = () => closed ??= (async () => {
    try {
      service.dispose();
      service.server.closeAllConnections();
      await new Promise((resolve) => service.server.close(resolve));
      await Promise.all(handling);
    } finally {
      restoreEnv();
    }
  })();
  t.after(close);
  return { ...service, port, close, api: (route, options = {}) => request(port, route, { token: service.token, ...options }) };
}
