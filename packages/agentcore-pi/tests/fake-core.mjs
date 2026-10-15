// A stand-in for `../agentcore-memory-core/src/index.mjs` in the factory test of `index.ts`.
// The test sets `state.config`; the fake records what the factory passes.
export const state = { config: null, env: null, created: [], resolved: [] };

export function loadConfig(env) {
  state.env = env;
  if (state.config instanceof Error) throw state.config;
  return state.config;
}

export function createCore(config) {
  state.created.push(config);
  return {
    config,
    async resolveProject(input) {
      state.resolved.push(input);
      return { projectId: null, role: null, source: "none" };
    },
    async recall() { return { records: [], failed: [] }; },
    formatContext() { return null; },
    async propose() { throw Object.assign(new Error("fake"), { code: "not_confirmed" }); },
    async close() {},
  };
}
