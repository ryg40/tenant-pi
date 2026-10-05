#!/usr/bin/env node
// Reapply host-provided peer declarations to installed Pi extension manifests.
// Usage: node patch_extension_peers.mjs [npm-root]   (default: <agent-dir>/npm)
// Offline. It edits only the named package.json files and is safe to rerun.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Pi 0.99 supplies these modules at runtime and warns when a package lists them under
// `dependencies`. An npm install or update restores the upstream manifest.
const packages = {
  "pi-hermes-memory": ["@earendil-works/pi-tui"],
  "@juicesharp/rpiv-ask-user-question": ["typebox"],
  "@zosmaai/pi-llm-wiki": ["@earendil-works/pi-tui", "typebox"],
};
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const npmRoot = resolve(process.argv[2] ?? join(agentDir, "npm"));

for (const [name, peers] of Object.entries(packages)) {
  const path = join(npmRoot, "node_modules", name, "package.json");
  if (!existsSync(path)) continue;
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.name !== name) throw new Error(`Unexpected package name in manifest for ${name}`);
  let changed = false;
  for (const peer of peers) {
    if (manifest.dependencies?.[peer] !== undefined) {
      delete manifest.dependencies[peer];
      changed = true;
    }
    if (manifest.peerDependencies?.[peer] !== "*") {
      manifest.peerDependencies ??= {};
      manifest.peerDependencies[peer] = "*";
      changed = true;
    }
  }
  if (!changed) continue;
  const indent = raw.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, indent)}\n`);
  renameSync(temporary, path);
  console.log(`Adjusted host-provided peers: ${name}`);
}
