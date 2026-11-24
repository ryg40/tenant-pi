import test from "node:test";
import assert from "node:assert/strict";
import { POSIX_ONLY_MESSAGE, posixOnlyRefusal } from "../src/posix-only.js";

test("the POSIX-only guard refuses only win32", () => {
  assert.equal(posixOnlyRefusal("win32"), POSIX_ONLY_MESSAGE);
  for (const platform of ["linux", "darwin", "freebsd"]) assert.equal(posixOnlyRefusal(platform), null);
});
