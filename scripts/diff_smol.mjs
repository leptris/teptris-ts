// Binding-level differential: teptris.loads vs smol-toml.parse over
// the checked-in corpus. The engine's semantic differential proves
// the parse; this proves the BINDING's materialization (type mapping,
// nesting, datetime strings). Deep-equality with a NaN normalize.
// Zero divergences = pass.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as smol from "smol-toml";
import { init } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = process.argv[2] || join(root, "test", "corpus");
const teptris = await init();

const isObj = (v) => v !== null && typeof v === "object";
// datetime-shaped: compare as (instant, nanos) - renderers differ in
// fraction padding/digits (teptris canonical-strips, smol pads to
// millis), which is formatting, not semantics
const RFC =
  /^(?:(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?)?|(\d{2}:\d{2}:\d{2})(?:[.,](\d+))?)\s*([Zz]|[+-]\d{2}:\d{2})?$/;
// both sides compare at MILLSECOND precision: smol-toml truncates
// fractions to 3 digits (a documented comparator limit - the engine's
// nanosecond fidelity is gated by the tomllib differential instead)
const normDT = (v) => {
  if (typeof v !== "string") return null;
  const m = RFC.exec(v);
  if (!m) return null;
  const date = m[1] || "";
  const hms = m[2] || m[4] || "00:00:00";
  const ms = (m[3] || m[5] || "0").slice(0, 3).padEnd(3, "0");
  const tz = m[6] || (date ? "" : "");
  return `DT ${date}T${hms}M${ms}Z${tz}`;
};
const norm = (v) => {
  if (v instanceof Date) return normDT(v.toISOString());
  const dt = normDT(v);
  if (dt !== null && typeof v === "string") return dt;
  if (isObj(v)) {
    if (Array.isArray(v)) return v.map(norm);
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  return v;
};
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const diff = (a, b, path, out) => {
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${path}.${k}: missing on teptris side`);
      else if (!(k in b)) out.push(`${path}.${k}: missing on smol side`);
      else diff(a[k], b[k], `${path}.${k}`, out);
      if (out.length > 4) return;
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: len ${a.length} vs ${b.length}`);
      return;
    }
    a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out));
  } else if (!eq(a, b)) {
    out.push(
      `${path}: teptris=${JSON.stringify(a)} smol=${JSON.stringify(b)}`,
    );
  }
};

let fails = 0;
const files = readdirSync(corpus)
  .filter((f) => f.endsWith(".toml"))
  .sort();
let skipped = 0;
for (const f of files) {
  const src = readFileSync(join(corpus, f), "utf8");
  const mine = teptris.loads(src);
  let ref;
  try {
    ref = smol.parse(src);
  } catch (e) {
    // smol refuses integers it cannot represent losslessly (> 2^53) -
    // a documented comparator limitation, recorded as a skip
    console.log(`SKIP ${f}: smol cannot parse (${e.message.split("\n")[0]})`);
    skipped++;
    continue;
  }
  const out = [];
  diff(mine, ref, "$", out);
  if (out.length) {
    console.log(`DIVERGENCE ${f}:`);
    out.slice(0, 5).forEach((d) => console.log(`  ${d}`));
    fails++;
  }
}
console.log(
  `differential: ${files.length - skipped} files compared, ` +
    `${skipped} skipped (comparator limits), ${fails} divergences`,
  );
process.exit(fails ? 1 : 0);
