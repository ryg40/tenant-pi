// Exact, copy-only selection of inclusive physical lines.
// Pure: no I/O, no clock, no randomness. Source text is inert data.

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

function fail(message: string): never {
  throw new SelectionError(message);
}

/**
 * Start offsets of every physical line. A line runs up to and including its LF
 * terminator; a preceding CR belongs to the line. A bare CR is not a
 * terminator. A trailing LF does not open an extra zero-byte line.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i + 1 < text.length) starts.push(i + 1);
  }
  return starts;
}

function checkLineNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${label} must be a safe integer`);
  }
  if (value < 1) fail(`${label} must be 1-based and positive`);
}

export function selectLines(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; startLine: number; endLine: number } {
  if (typeof text !== "string") fail("source must be a string");
  if (text.length === 0) fail("source must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    fail("source exceeds the 2 MiB selection bound");
  }
  checkLineNumber(startLine, "startLine");
  checkLineNumber(endLine, "endLine");
  if (startLine > endLine) fail("line range is reversed");

  const starts = lineStarts(text);
  if (endLine > starts.length) fail("line range is out of range");

  const from = starts[startLine - 1]!;
  const to = endLine < starts.length ? starts[endLine]! : text.length;
  return Object.freeze({ text: text.slice(from, to), startLine, endLine });
}
