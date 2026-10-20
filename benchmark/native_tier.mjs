// Native tier: the retained-document roundtrip (loadsDoc + dumpDoc -
// zero JS objects materialized) vs smol-toml's parse+stringify (its
// dict roundtrip). The native-doc API's home cell.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as smol from "smol-toml";
import { init } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = process.argv[2] || join(root, "../teptris/bench-corpus");
const reps = Number(process.argv[3] || 40);

const teptris = await init();

function bench(call, src) {
  call(src);
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    call(src);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (dt < best) best = dt;
  }
  return best;
}

for (const f of readdirSync(corpus).sort()) {
  const src = readFileSync(join(corpus, f), "utf8");
  const cells = [];
  for (const [name, fn] of [
    ["teptris native", (s) => teptris.dumpDoc(teptris.loadsDoc(s))],
    ["smol dict", (s) => smol.stringify(smol.parse(s))],
  ]) {
    try {
      const ms = bench(fn, src);
      cells.push(`${name} ${ms.toFixed(2)} ms ${(src.length / 1048576 / (ms / 1000)).toFixed(1)} MB/s`);
    } catch (e) {
      cells.push(`${name} ERROR: ${e.message}`);
    }
  }
  console.log(`${f.padEnd(20)} ${cells.join(" | ")}`);
}
