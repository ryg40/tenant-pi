import test from "node:test";

// Compare refuses on Windows (src/posix-only.js), so its tests skip there and keep running on Linux and macOS.
export const posixOnly = { skip: process.platform === "win32" && "POSIX-only mode: needs Linux or macOS" };

/** node:test `test` whose tests skip on Windows; a drop-in for files that test only Compare. */
export default function posixTest(name, options, fn) {
  if (typeof options === "function") [options, fn] = [{}, options];
  return test(name, posixOnly.skip ? { ...options, ...posixOnly } : options, fn);
}
posixTest.after = test.after;
