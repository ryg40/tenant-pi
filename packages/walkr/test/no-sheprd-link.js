// Loaded first by `npm test` (package.json, node --import). The optional Sheprd link must never reach the real
// `sheprd` from a test: no test inherits WALKR_SHEPRD_CONNECT from the outer shell. sheprd-link.test.js sets it
// for its own children, with a fake `sheprd`.
delete process.env.WALKR_SHEPRD_CONNECT;
