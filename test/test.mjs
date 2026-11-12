import test from "node:test";
import assert from "node:assert/strict";
import initModule from "../dist/teptris.mjs";
import teptrisInit, { init, initApi } from "../src/index.js";

// the consumer path: init() loads + instantiates + wraps
const { loads, dump, dumpJson, planBuild, planWalk, planFree,
  engineVersion } = await init();

test("initApi wraps a raw module (advanced path)", async () => {
  const mod = await initModule();
  const api = initApi(mod);
  assert.deepEqual(api.loads("a = 1"), { a: 1 });
  assert.equal(api.engineVersion(), engineVersion());
});

test("loads returns natural JSON", () => {
  const doc = loads('name = "wasm"\nport = 8080\nratio = 1.5\non = true\n' +
                    '[server]\nhost = "0.0.0.0"\narr = [1, "two", 3.5]\n');
  assert.equal(doc.name, "wasm");
  assert.equal(doc.port, 8080);
  assert.equal(doc.ratio, 1.5);
  assert.equal(doc.on, true);
  assert.equal(doc.server.host, "0.0.0.0");
  assert.equal(doc.server.arr[2], 3.5);
});

test("datetimes come back as RFC 3339 strings", () => {
  const dts = loads('o = 1979-05-27T07:32:00-07:00\nd = 1979-05-27\nt = 07:32:00\n');
  assert.equal(dts.o, "1979-05-27T07:32:00-07:00");
  assert.equal(dts.d, "1979-05-27");
  assert.equal(dts.t, "07:32:00");
});

test("non-finite floats are null (documented lossy mapping)", () => {
  assert.equal(loads("x = nan\n").x, null);
});

test("errors carry message + line/column", () => {
  assert.throws(() => loads("bogus =\n"), (e) => e instanceof Error && e.line >= 1);
});

test("dump round-trips through the builder", () => {
  const src = 'name = "rt"\nport = 8080\nratio = 0.25\non = false\n' +
              'o = 1979-05-27T07:32:00-07:00\n' +
              '[server]\nhost = "h"\narr = [1, 2]\n' +
              '[[items]]\nid = 1\n[[items]]\nid = 2\n';
  const v = loads(src);
  const v2 = loads(dump(v));
  assert.deepEqual(v, v2);
});

test("dump accepts plain JS objects", () => {
  const back = loads(dump({ a: 1, b: [1.5, "x"], nested: { k: true } }));
  assert.equal(back.a, 1);
  assert.equal(back.b[0], 1.5);
  assert.equal(back.nested.k, true);
});

test("dump rejects non-table roots", () => {
  assert.throws(() => dump([1, 2]), TypeError);
});

test("dumpJson emits host JSON (untagged)", () => {
  const v = { i: 42, f: 3.5, t: true, s: "hi", at: "2026-10-09T12:00:00Z" };
  const j = JSON.parse(dumpJson(v));
  assert.deepEqual(j, v);
});

test("dumpJson maps non-finite floats to null", () => {
  const j = JSON.parse(dumpJson({ nan: NaN, inf: Infinity, ok: 1.0 }));
  assert.equal(j.nan, null);
  assert.equal(j.inf, null);
  assert.equal(j.ok, 1.0);
});

test("dumpJson rejects non-table roots like dump", () => {
  assert.throws(() => dumpJson([1, 2]), TypeError);
});

test("engineVersion reports", () => {
  assert.match(engineVersion(), /^\d+\.\d+\./);
});

test("planWalk materializes only planned keys", () => {
  const plan = planBuild([
    "title",
    "pi",
    { name: "owner", rows: ["name"] },
    "secret",
  ]);
  const view = planWalk(
    plan,
    'title = "d"\npi = 3.5\nsecret = "x"\n[owner]\nname = "r"\nk = 9\n');
  assert.deepEqual(view,
    { title: "d", pi: 3.5, secret: "x", owner: { name: "r" } });
  planFree(plan);
});

test("planWalk: missing and mismatched rows are absent (no nulls)", () => {
  const plan = planBuild([
    "missing",
    { name: "pi", kind: "collection" },
    { name: "missing_table", kind: "raw" },
  ]);
  const view = planWalk(plan, "pi = 3.5\n");
  assert.deepEqual(view, {});
  planFree(plan);
});

test("planWalk: datetimes come back as RFC 3339 strings", () => {
  const plan = planBuild(["at"]);
  const view = planWalk(plan, "at = 2026-10-09T12:00:00Z\n");
  assert.equal(view.at, "2026-10-09T12:00:00Z");
  planFree(plan);
});

test("planWalk: raw rows take the untouched subtree", () => {
  const plan = planBuild([
    { name: "extra", kind: "raw" },
    { name: "items", kind: "raw" },
  ]);
  const view = planWalk(
    plan,
    'x = 1\n[extra]\nk = 1\n[[items]]\nid = 1\n[[items]]\nid = 2\n');
  assert.deepEqual(view, { extra: { k: 1 }, items: [{ id: 1 }, { id: 2 }] });
  planFree(plan);
});

test("planWalk: sibling nested rows keep their own sub-plans", () => {
  const plan = planBuild([
    { name: "a", rows: ["x"] },
    { name: "b", rows: ["y"] },
  ]);
  const view = planWalk(plan, "[a]\nx = 1\n[b]\ny = 2\n");
  assert.deepEqual(view, { a: { x: 1 }, b: { y: 2 } });
  planFree(plan);
});

test("planWalk: one plan serves many documents", () => {
  const plan = planBuild(["v"]);
  assert.deepEqual(planWalk(plan, "v = 1\n"), { v: 1 });
  assert.deepEqual(planWalk(plan, "v = 2\n"), { v: 2 });
  planFree(plan);
});

test("planWalk: a scalar row over a table value is absent", () => {
  const plan = planBuild(["t"]);
  const view = planWalk(plan, "[t]\nk = 1\n");
  assert.deepEqual(view, {});
  planFree(plan);
});

test("planWalk surfaces parse errors with position", () => {
  const plan = planBuild(["a"]);
  assert.throws(() => planWalk(plan, "bogus ="), (e) => e.line >= 1);
  planFree(plan);
});

test("planBuild rejects empty plans", () => {
  assert.throws(() => planBuild([]), TypeError);
});

// ---- the dump integer-path guards (audit P0: silent int64 wraps) ----

test("i64-max-shaped loads output dumps as a float, not a wrap", () => {
  // JS numbers past 2^53 cannot carry 9223372036854775807 exactly; the
  // natural-JSON loads hands back 9223372036854776000. That value sits
  // past int64 max, so the dump integer path must refuse it and emit a
  // float instead - it used to WRAP to INT64_MIN silently.
  const doc = loads("a = 9223372036854775807\n");
  const text = dump(doc);
  assert.ok(!text.includes("-9223372036854775808"), text);
  assert.equal(loads(text).a, 9223372036854776000);
});

test("1e21 stays a float (Number.isInteger(1e21) is true)", () => {
  const text = dump(loads("a = 1e21\n"));
  assert.ok(!text.includes("3875820019684212736"), text);
  assert.ok(text.includes("1e21"), text);
  assert.equal(loads(text).a, 1e21);
});

test("nesting past 512 dumps with the named depth error", () => {
  let deep = { v: 1 };
  for (let i = 0; i < 5000; i++) deep = { n: deep };
  assert.throws(() => dump(deep), /nesting too deep/);
  let deepArr = { v: 1 };
  for (let i = 0; i < 600; i++) deepArr = [deepArr];
  assert.throws(() => dump({ a: deepArr }), /nesting too deep/);
});

test("integral-valued floats re-enter as integers (documented floor)", () => {
  // JSON numbers carry no int/float distinction: the engine's float
  // -776571136.0 loads as a plain JS number and dump's integer path
  // re-emits it without the .0 (py/ruby/rs keep the type). Pinned as
  // the documented loads floor - NOT a wrap, the value is exact.
  const text = dump(loads("a = -776571136.0\n"));
  assert.equal(text, "a = -776571136\n");
  assert.equal(loads(text).a, -776571136);
});

test("mixed arrays carry no key markers (grammar v0.3.11)", () => {
  // the v0.3.10 empty-key change made the old klen-0 array-element
  // marker a genuine pending empty key; the stale key tripped the
  // inline-element guard and [1, {c: "x"}] failed ERR_ARG (npm
  // 0.3.14 shipped it - this is the regression test)
  const text = dump({ b: [1, { c: "x" }] });
  assert.equal(text, "b = [1, {c = 'x'}]\n");
  assert.deepEqual(loads(text), { b: [1, { c: "x" }] });
  assert.equal(dump({ m: [[1, "a"], [2, "b"]] }), "m = [[1, 'a'], [2, 'b']]\n");
});

test("-0.0 keeps its sign", () => {
  assert.equal(dump(loads("a = -0.0\n")), "a = -0.0\n");
  assert.equal(dump({ a: -0.0 }), "a = -0.0\n");
});

test("dumpJson takes the same guards (builder path)", () => {
  const text = dumpJson(loads("a = 1e21\n"));
  assert.ok(!text.includes("3875820019684212736"), text);
  const neg = JSON.parse(dumpJson({ a: -0.0 }));
  assert.ok(Object.is(neg.a, -0) || neg.a === 0, "no wrap; sign handled");
});

test("bigints dump exactly inside int64, throw outside", () => {
  assert.equal(dump({ a: 9007199254740993n }), "a = 9007199254740993\n");
  assert.equal(dump({ a: -9223372036854775808n }), "a = -9223372036854775808\n");
  assert.throws(() => dump({ a: 9223372036854775808n }), /int64 range/);
  assert.throws(() => dump({ a: -9223372036854775809n }), /int64 range/);
});

test("2^63-1-shaped numbers take the float path (the literal rounds)", () => {
  // 9223372036854775807 is not representable; the JS literal IS 2^63,
  // which sits outside the exclusive bound - float, no wrap
  assert.equal(dump({ a: 9223372036854775807 }), "a = 9.223372036854776e18\n");
});

test("edit rewrites exactly the value bytes", async () => {
  const { edit } = await init();
  const src = "# c\n[serve]\nport = 8080  # keep\n";
  assert.equal(
    edit(src, "serve.port", "9090"),
    "# c\n[serve]\nport = 9090  # keep\n");
});

test("edit splices multiline and inline targets, preserves CRLF", async () => {
  const { edit } = await init();
  assert.equal(
    edit("m = \"\"\"\nline\n\"\"\"\nz = 1\n", "m", "\"n\""),
    "m = \"n\"\nz = 1\n");
  assert.equal(edit("t = {a = 1}\n", "t", "{a = 2}"), "t = {a = 2}\n");
  assert.equal(
    edit("# c\r\nport = 8080\r\n", "port", "9090"),
    "# c\r\nport = 9090\r\n");
});

test("edit throws on a missing key and a malformed replacement", async () => {
  const { edit } = await init();
  assert.throws(() => edit("a = 1\n", "b", "2"), /edit failed/);
  assert.throws(() => edit("a = 1\n", "a", "@@@"), /edit failed|parse failed/);
});

test("AoT-element nested tables promote to sections (engine-canonical)", async () => {
  const { dump } = await init();
  assert.equal(dump({ t: [{ x: 1, y: { z: 2 } }] }), "[[t]]\nx = 1\n[t.y]\nz = 2\n");
  assert.equal(
    dump({ t: [{ x: 1, subs: [{ n: "a" }] }] }),
    "[[t]]\nx = 1\n[[t.subs]]\nn = 'a'\n");
  // a genuinely inline context (mixed array) keeps inline tables
  assert.equal(dump({ arr: [1, { a: 1 }] }), "arr = [1, {a = 1}]\n");
  // round-trip: the promoted sections parse back to the same tree
  const { loads } = await init();
  const doc = { t: [{ x: 1, y: { z: 2 } }] };
  assert.deepEqual(loads(dump(doc)), doc);
});

test("dump accepts Date values (the JS ecosystem datetime shape)", async () => {
  const { dump, dumpJson, loads } = await init();
  assert.equal(dump({ d: new Date("2026-11-02T10:00:00Z") }),
    "d = 2026-11-02T10:00:00Z\n");
  assert.equal(dump({ ds: [new Date("2026-11-02T10:00:00Z")] }),
    "ds = [2026-11-02T10:00:00Z]\n");
  const nested = { o: { d: new Date("2026-11-02T10:00:00Z") } };
  assert.equal(dump(nested), "[o]\nd = 2026-11-02T10:00:00Z\n");
  assert.equal(dumpJson({ d: new Date("2026-11-02T10:00:00Z") }),
    '{"d":"2026-11-02T10:00:00Z"}');
  // a Date was previously mis-typed as a table (an opaque engine error)
  assert.deepEqual(loads(dump(nested)), { o: { d: "2026-11-02T10:00:00Z" } });
});

test("dump: datetime literals ride as text (engine 0.3.27 DATETIME-TEXT)", () => {
  // the literal crosses the bridge RAW; the engine parses it at op
  // decode (teptris_datetime_from_str) and emits canonical bytes -
  // no JS regex/field-extraction on the dump hot path
  assert.equal(dump({ d: "2026-11-02T10:00:00Z" }), "d = 2026-11-02T10:00:00Z\n");
  // the ms form (Date.toISOString's shape) normalizes
  assert.equal(dump({ d: "2026-11-02T10:00:00.000Z" }), "d = 2026-11-02T10:00:00Z\n");
  // shape-valid, calendar-invalid literals error loudly (the engine
  // is the datetime authority)
  assert.throws(() => dump({ d: "2026-02-30" }), /invalid/);
});

// ---- schema validation (engine 0.3.20) ----

const { compileSchema } = await init();

const manifestSchema = JSON.stringify({
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1 },
    mode: { enum: ["fast", "safe"] },
  },
  required: ["name", "port"],
});

test("compileSchema + validate: typed violations", () => {
  const schema = compileSchema(manifestSchema);
  const ok = schema.validate('name = "srv"\nport = 8080\n');
  assert.deepEqual(ok, []);
  assert.equal(schema.isValid('name = "srv"\nport = 8080\n'), true);

  const bad = schema.validate('name = ""\nport = 0\n');
  assert.equal(bad.length, 2);
  assert.deepEqual(
    Object.keys(bad[0]).sort(),
    ["message", "path", "schemaPath"]);
  assert.equal(bad[0].path, "name");
  assert.equal(bad[1].path, "port");

  const missing = schema.validate("port = 1\n");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "");
  assert.ok(missing[0].message.includes("name"));

  assert.equal(schema.isValid("port = 1\n"), false);
});

test("compileSchema: long plain tail after an escape", () => {
  // engine 0.3.26: the JSON reader sized the escaped-string rebuild
  // from the prefix alone; a long plain tail after the first escape
  // wrote past the arena block (fuzz finding)
  const json = '{"description":"A\\u00e9' + "B".repeat(128 * 1024) + '"}';
  const schema = compileSchema(json);
  assert.equal(schema.validate("k = 1\n").length, 0);
});

test("compile rejects unsupported constructs with the named keyword", () => {
  // unevaluatedProperties is enforced since engine 0.3.22
  const enforced = compileSchema('{"unevaluatedProperties":false}');
  assert.equal(enforced.validate("a = 1\n").length, 1);
  assert.throws(
    () => compileSchema('{"$ref":"https://x.example/s.json"}'),
    (e) => e instanceof Error && /remote/.test(e.message));
  assert.throws(
    () => compileSchema('{"$ref":"https://x.example/s.json"}'),
    (e) => e instanceof Error && /remote/.test(e.message));
  assert.throws(
    () => compileSchema('{"type":}'),
    (e) => e instanceof Error && /error/.test(e.message));
});

test("unknown keywords are extensions, not rejections", () => {
  const schema = compileSchema(
    '{"x-vendor":true,"properties":{"k":{"type":"integer"}}}');
  assert.equal(schema.isValid("k = 1\n"), true);
  assert.equal(schema.isValid('k = "s"\n'), false);
});

test("the four policies hold from JS", () => {
  // policy 2: float never integer; enum type-strict
  const strict = compileSchema('{"properties":{"k":{"enum":[1]}}}');
  assert.equal(strict.isValid("k = 1\n"), true);
  // 2020-12 numeric identity since engine 0.3.23
  assert.equal(strict.isValid("k = 1.0\n"), true);
  assert.equal(strict.isValid("k = 1.5\n"), false);

  // policy 3: datetimes are strings with formats
  const dt = compileSchema(
    '{"properties":{"k":{"type":"string","format":"date-time"}}}');
  assert.equal(dt.isValid("k = 2026-01-02T03:04:05Z\n"), true);
  assert.equal(dt.isValid('k = "soon"\n'), false);

  // policy 4: nan fails every ordered comparison, inf rides minimums
  const lo = compileSchema('{"properties":{"k":{"minimum":0}}}');
  assert.equal(lo.isValid("k = nan\n"), false);
  assert.equal(lo.isValid("k = inf\n"), true);

  // policy 1: bare null in a type array means "or absent"
  const opt = compileSchema('{"properties":{"k":{"type":["string",null]}}}');
  assert.equal(opt.isValid('k = "s"\n'), true);
  assert.equal(opt.isValid("j = 1\n"), true);
  assert.equal(opt.isValid("k = 1\n"), false);
});

test("recursive $ref memoizes", () => {
  const tree = compileSchema(
    '{"properties":{"v":{"type":"integer"},' +
    '"kids":{"type":"array","items":{"$ref":"#"}}},"required":["v"]}');
  assert.equal(
    tree.isValid("v = 0\n[[kids]]\nv = 1\n[[kids.kids]]\nv = 2\n"),
    true);
  const bad = tree.validate('v = 0\n[[kids]]\nv = "x"\n');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "kids.0.v");
});

test("syntax errors throw with the engine status", () => {
  const schema = compileSchema("{}");
  assert.throws(() => schema.validate("a = = 1\n"),
                (e) => e instanceof Error && e.status > 0);
});

test("free() releases and is idempotent", () => {
  const schema = compileSchema("{}");
  assert.equal(schema.isValid("k = 1\n"), true);
  schema.free();
  schema.free();
});

test("the taplo parity surface rides engine 0.3.21", async () => {
  const deps = compileSchema(
    '{"dependencies":{"credit_card":["billing_address"]}}'
  );
  assert.equal(deps.validate("a = 1\ncredit_card = 1\n").length, 1);
  assert.equal(
    deps.validate("credit_card = 1\nbilling_address = 'x'\n").length, 0);

  const tuple = compileSchema(
    '{"properties":{"t":{"items":[{"type":"string"}],"additionalItems":false}}}'
  );
  assert.equal(tuple.validate("t = ['x']\n").length, 0);
  assert.equal(tuple.validate("t = ['x', 1]\n").length, 1);

  const mult = compileSchema('{"properties":{"k":{"multipleOf":0.1}}}');
  assert.equal(mult.validate("k = 0.3\n").length, 0);
  assert.equal(mult.validate("k = 0.35\n").length, 1);

  const uuid = compileSchema('{"properties":{"k":{"format":"uuid"}}}');
  assert.equal(
    uuid.validate("k = '123e4567-e89b-12d3-a456-426614174000'\n").length, 0);
  assert.equal(uuid.validate("k = 'nope'\n").length, 1);
});


test("the SOTA surface rides engine 0.3.22", () => {
  // the cousin rule: allOf siblings do not share annotations
  const cousin = compileSchema(
    '{"allOf":[{"properties":{"a":{}}},{"unevaluatedProperties":false}]}'
  );
  assert.equal(cousin.validate("a = 1\n").length, 1);

  // same-object adjacency holds
  const adjacent = compileSchema(
    '{"properties":{"a":{}},"unevaluatedProperties":false}'
  );
  assert.equal(adjacent.validate("a = 1\n").length, 0);
  assert.equal(adjacent.validate("a = 1\nb = 2\n").length, 1);

  // dynamic refs resolve to the innermost anchor
  const tree = compileSchema(
    '{"$dynamicAnchor":"node","type":"object","properties":' +
    '{"value":{"type":"integer"},"children":{"type":"array",' +
    '"items":{"$dynamicRef":"#node"}}}}'
  );
  assert.equal(tree.validate("value = 1\n[[children]]\nvalue = 2\n").length, 0);
  assert.equal(tree.validate("value = 1\n[[children]]\nvalue = 'x'\n").length, 1);

  // contentSchema asserts the decoded content
  const content = compileSchema(
    '{"properties":{"k":{"contentEncoding":"base64",' +
    '"contentMediaType":"application/json",' +
    '"contentSchema":{"type":"object","required":["n"]}}}}'
  );
  assert.equal(content.validate("k = 'eyJuIjogMX0='\n").length, 0);
  assert.equal(content.validate("k = 'W10='\n").length, 1);

  // the TOML-native local formats
  const local = compileSchema(
    '{"properties":{"k":{"format":"time-local"}}}'
  );
  assert.equal(local.validate("k = 07:32:00\n").length, 0);
  assert.equal(local.validate("k = '07:32:00Z'\n").length, 1);
});

test("vendored metaschemas resolve in memory (engine 0.3.23)", () => {
  const schema = compileSchema(
    '{"$ref":"https://json-schema.org/draft/2020-12/schema"}'
  );
  assert.equal(schema.validate('type = "string"\n').length, 0);
  assert.equal(schema.validate("type = 123\n").length, 1);

  const d7 = compileSchema(
    '{"$ref":"http://json-schema.org/draft-07/schema#"}'
  );
  assert.equal(d7.validate('description = "d"\n').length, 0);

  assert.equal(engineVersion(), "0.3.30");
});

test("dialect-gated formats (engine 0.3.26)", () => {
  const plain = compileSchema('{"properties":{"k":{"format":"email"}}}');
  assert.equal(plain.validate("k = '2962'\n").length, 1);
  const anno = compileSchema(
    '{"$schema":"https://json-schema.org/draft/2020-12/schema",' +
    '"properties":{"k":{"format":"email"}}}'
  );
  assert.equal(anno.validate("k = '2962'\n").length, 0);
  const assertion = compileSchema(
    '{"$schema":"https://json-schema.org/draft/2020-12/format-assertion",' +
    '"properties":{"k":{"format":"email"}}}'
  );
  assert.equal(assertion.validate("k = '2962'\n").length, 1);
});

test("unicode property escapes (engine 0.3.24)", () => {
  const letter = compileSchema(
    '{"properties":{"k":{"pattern":"^\\\\p{Letter}+$"}}}'
  );
  assert.equal(letter.validate('k = "π"\n').length, 0);
  assert.equal(letter.validate("k = '123'\n").length, 1);
  const neg = compileSchema(
    '{"properties":{"k":{"pattern":"^\\\\P{Letter}+$"}}}'
  );
  assert.equal(neg.validate("k = '123'\n").length, 0);
  assert.equal(engineVersion(), "0.3.30");
});
