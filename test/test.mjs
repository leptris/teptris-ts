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
