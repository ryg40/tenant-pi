/**
 * Print every footer fixture at 160, 120, 80, and 40 columns, with color and without. Default layout v4; `--layout all` prints all six.
 * Run: node --experimental-strip-types scripts/footer-preview.ts [--plain] [--widths 160,120] [--only "healthy,pending prompt"] [--layout v4|v3|v2|a|b|c|all]
 * Not part of the Pi package files.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { ansiPaint, plainPaint } from "../extensions/ops-footer/paint.ts";
import { defaultLayout, isLayoutName, layoutNames, layouts } from "../extensions/ops-footer/layouts/index.ts";
import { defaults } from "../extensions/ops-footer/settings.ts";
import { fixtures, NOW } from "../test/footer-fixtures.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const widths = (option("--widths") ?? "160,120,80,40").split(",").map(Number);
const only = (option("--only") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const layoutOption = option("--layout") ?? defaultLayout;
if (layoutOption !== "all" && !isLayoutName(layoutOption)) { console.error(`Unknown layout ${layoutOption}. Use ${layoutNames.join("|")}|all.`); process.exit(1); }
const selected = layoutOption === "all" ? layoutNames : [layoutOption];
const paints = args.includes("--plain") ? [plainPaint] : args.includes("--color") ? [ansiPaint] : [ansiPaint, plainPaint];
const settings = { ...defaults, healthUrls: {} };
for (const fixture of fixtures) {
  if (only.length && !only.some(part => fixture.name.includes(part))) continue;
  for (const layout of selected) for (const paint of paints) {
    console.log(`\n== ${fixture.name} · layout ${layout} (${paint.color ? "color" : "no color"}) ==`);
    for (const width of widths) {
      const { above, below } = layouts[layout](fixture.data, fixture.context, settings, width, paint, NOW);
      console.log(`-- ${width} columns, ${above.length} above and ${below.length} below the editor`);
      for (const row of [...above, ...(above.length ? ["[editor]"] : []), ...below]) {
        if (visibleWidth(row) > width) console.log(`!! width ${visibleWidth(row)} exceeds ${width}`);
        console.log(row);
      }
    }
  }
}
