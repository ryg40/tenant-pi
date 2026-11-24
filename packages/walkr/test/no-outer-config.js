import os from "node:os";
// Remote mode reads the key `remote` of the artifacts config file under XDG_CONFIG_HOME (src/compare-remote.js). No
// test reads the config file of the outer user: the value names a directory that does not exist, so each command
// stays local. Each test file that starts the CLI or the server imports this module first, so the rule holds also in a
// single-file run (`node --test test/compare.test.js`); the `npm test` preload (no-sheprd-link.js) imports it too.
// compare-remote.test.js sets its own value for its children.
process.env.XDG_CONFIG_HOME = `${os.tmpdir()}/walkr-test-no-config-${process.pid}-${Date.now()}`;
