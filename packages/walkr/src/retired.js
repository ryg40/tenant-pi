// The retired Walkr commands. Core, Double, Coinflip, Trainer and the shared GUI are retired since 2026-11-23.
// The four command files stay as stubs, so a link of an older install fails with one clear line and not with a
// shell error about a missing file. `package.json` lists no bin for them: a new install makes no such link.
export const RETIRED_TAG = "portable/20261122-548259a";

export function retiredLine(name) {
  return `${name} is retired. Walkr keeps Compare only: use walkr-compare. The last release with the old code is the release tag ${RETIRED_TAG}.`;
}

/** Print the one line and set exit code 2. Help prints the same line with exit code 0. */
export function refuseRetired(name, args = process.argv.slice(2)) {
  const help = args.length === 1 && ["--help", "-h", "help"].includes(args[0]);
  if (help) console.log(retiredLine(name));
  else { console.error(retiredLine(name)); process.exitCode = 2; }
}
