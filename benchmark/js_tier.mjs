// JS tier: teptris (wasm) vs the JS ecosystem's TOML parsers over the
// engine bench corpus — the family's last unmeasured tier. Comparators:
//   @iarna/toml  — the long-standing standard parser
//   smol-toml    — the modern fast one
// Dumps: dump (TOML) vs each comparator's stringify; dumpJson vs
// JSON.stringify (the native baseline, on datetime-as-string input).
// Datetime parity note: @iarna/toml parses datetimes into Date objects
// while teptris/smol produce RFC 3339 strings — a value-shape
// difference, not a speed artifact.
//   node benchmark/js_tier.mjs [corpus-dir] [reps]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import iarna from "@iarna/toml";
import * as smol from "smol-toml";
import * as jt from "@ltd/j-toml";
import { init } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = process.argv[2] || join(root, "../teptris/bench-corpus");
const reps = Number(process.argv[3] || 40);

const teptris = await init();

function bench(call, src) {
  call(src); // warmup
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    call(src);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (dt < best) best = dt;
  }
  return best;
}

// @iarna/toml still enforces a pre-1.0 single-type-array rule, so
// some legal-TOML-1.0 corpus shapes fail to parse under it — report
// the rejection instead of letting it kill the run.
function safeBench(call, src) {
  try {
    return bench(call, src);
  } catch (e) {
    return null;
  }
}

function fmt(v) {
  return v === null ? "  reject" : v.toFixed(2).padStart(8);
}

console.log(`shape                       teptris   @iarna     smol      j-toml   (loads, ms best-of-${reps})`);
for (const f of readdirSync(corpus).filter((x) => x.endsWith(".toml")).sort()) {
  const src = readFileSync(join(corpus, f), "utf8");
  const t = bench(teptris.loads, src);
  const i = safeBench(iarna.parse, src);
  const sm = safeBench(smol.parse, src);
  const jt_ = safeBench((x) => jt.parse(x, { max_async: -1 }), src);
  console.log(
    `${f.padEnd(20)} ${t.toFixed(2).padStart(8)} ${fmt(i)} ${fmt(sm)} ${fmt(jt_)}`,
  );
}

console.log(`\nshape                       teptris   @iarna     smol      j-toml   (dumps -> TOML, ms)`);
for (const f of readdirSync(corpus).filter((x) => x.endsWith(".toml")).sort()) {
  const obj = teptris.loads(readFileSync(join(corpus, f), "utf8"));
  const smolObj = smol.parse(readFileSync(join(corpus, f), "utf8"));
  const t = bench(teptris.dump, obj);
  const i = safeBench((o) => iarna.stringify(o), obj);
  const sm = safeBench((o) => smol.stringify(o), smolObj);
  const jt_ = safeBench((o) => jt.stringify(o), smolObj);
  console.log(
    `${f.padEnd(20)} ${t.toFixed(2).padStart(8)} ${fmt(i)} ${fmt(sm)} ${fmt(jt_)}`,
  );
}

console.log(`\nshape                 tep-json  JSON.stringify   (natural JSON string, ms)`);
for (const f of readdirSync(corpus).filter((x) => x.endsWith(".toml")).sort()) {
  const obj = teptris.loads(readFileSync(join(corpus, f), "utf8"));
  const t = bench(teptris.dumpJson, obj);
  const j = bench((o) => JSON.stringify(o), obj);
  console.log(`${f.padEnd(20)} ${t.toFixed(2).padStart(8)} ${j.toFixed(2).padStart(12)}`);
}
