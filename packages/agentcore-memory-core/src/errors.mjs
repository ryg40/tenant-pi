// A diagnostic of the core. The message is the static code: it never holds request data.
export class MemoryError extends Error {
  constructor(code) {
    super(`agentcore-memory: ${code}`);
    this.name = "MemoryError";
    this.code = code;
  }
}

export const failure = (code) => new MemoryError(code);
