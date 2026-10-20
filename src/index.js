// The public surface: natural-JSON loads + builder-driven dumps.
// Engine FFI through ../dist/teptris.mjs (built by build.sh).

const KIND_OFFSET = 4, KIND_LOCAL_DT = 5, KIND_DATE = 6, KIND_TIME = 7;

function cstr(mod, s) {
  const bytes = mod.lengthBytesUTF8(s) + 1;
  const ptr = mod._teptris_wasm_alloc(bytes);
  mod.stringToUTF8(s, ptr, bytes);
  return ptr;
}

function freeCstr(mod, ptr) { mod._teptris_wasm_free(ptr); }

// RFC 3339-ish (the four TOML shapes) back into builder fields
function parseDateTime(str) {
  let m = str.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/);
  if (m) {
    const kind = m[8] ? KIND_OFFSET : KIND_LOCAL_DT;
    let offset = 0;
    if (m[8] && m[8] !== "Z") {
      const sign = m[8][0] === "-" ? -1 : 1;
      const hh = parseInt(m[8].slice(1, 3), 10);
      const mm = parseInt(m[8].slice(4, 6), 10);
      offset = sign * (hh * 3600 + mm * 60);
    }
    return {
      kind, year: +m[1], month: +m[2], day: +m[3], hour: +m[4],
      minute: +m[5], second: +m[6],
      nanosecond: m[7] ? Math.floor(+("0." + m[7]) * 1e9) : 0,
      offset_seconds: offset,
    };
  }
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { kind: KIND_DATE, year: +m[1], month: +m[2], day: +m[3],
             hour: 0, minute: 0, second: 0, nanosecond: 0,
             offset_seconds: 0 };
  }
  m = str.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (m) {
    return { kind: KIND_TIME, year: 0, month: 0, day: 0, hour: +m[1],
             minute: +m[2], second: +m[3],
             nanosecond: m[4] ? Math.floor(+("0." + m[4]) * 1e9) : 0,
             offset_seconds: 0 };
  }
  return null;
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(\.\d+)?$/;

// cheap charset pre-check before the RFC 3339 regex: datetimes start
// with a digit and only ever contain digits, date/time punctuation
// and TZ marks - rejects nearly all plain strings without the regex
const DATETIME_CHARS = /[0-9Tt: .+Zz-]/;
const utf8 = new TextDecoder("utf-8");
function maybeRfc3339(v) {
  const c0 = v.charCodeAt(0);
  if (!(c0 >= 48 && c0 <= 57)) return false;
  for (let i = 1; i < v.length; i++) {
    if (!DATETIME_CHARS.test(v[i])) return false;
  }
  return true;
}

function buildValue(mod, b, key, v, errs) {
  const kp = key == null ? 0 : cstr(mod, key);
  try {
    if (v === null || v === undefined) {
      throw new Error("null/undefined cannot round-trip through TOML");
    }
    switch (typeof v) {
      case "number":
        if (Number.isInteger(v)) {
          mod._teptris_wasm_builder_put_integer(b, kp, BigInt(v));
        } else {
          mod._teptris_wasm_builder_put_float(b, kp, v);
        }
        return;
      case "boolean":
        mod._teptris_wasm_builder_put_boolean(b, kp, v ? 1 : 0);
        return;
      case "string":
        // RFC 3339 strings from loads() re-enter as datetimes; a
        // plain string stays a string
        if (RFC3339.test(v)) {
          const dt = parseDateTime(v);
          mod._teptris_wasm_builder_put_datetime(
            b, kp, dt.kind, dt.year, dt.month, dt.day, dt.hour,
            dt.minute, dt.second, dt.nanosecond, dt.offset_seconds);
          return;
        }
        const vp = cstr(mod, v);
        mod._teptris_wasm_builder_put_string(b, kp, vp);
        freeCstr(mod, vp);
        return;
      default:
        break;
    }
    if (Array.isArray(v)) {
      mod._teptris_wasm_builder_open_array(b, kp);
      for (const item of v) buildValue(mod, b, null, item, errs);
      mod._teptris_wasm_builder_close(b);
      return;
    }
    if (typeof v === "object") {
      // open_table with a NULL key = element of the current array
      // (array-of-tables); the root table itself is implicit (see
      // dump - it iterates root entries directly)
      mod._teptris_wasm_builder_open_table(b, kp);
      for (const [k, item] of Object.entries(v)) {
        buildValue(mod, b, k, item, errs);
      }
      mod._teptris_wasm_builder_close(b);
      return;
    }
    errs.push(new Error(`unsupported value: ${String(v)}`));
  } finally {
    if (kp) freeCstr(mod, kp);
  }
}

import createModule from "../dist/teptris.mjs";

export function initApi(mod) {
  const { UTF8ToString, stringToUTF8, lengthBytesUTF8 } = mod;

  function loads(toml) {
    if (typeof toml !== "string") {
      throw new TypeError("loads expects a string");
    }
    const ptr = cstr(mod, toml);
    const st = mod._teptris_wasm_load(ptr, lengthBytesUTF8(toml));
    let value = null, error = null;
    if (st === 0) {
      const jptr = mod._teptris_wasm_json();
      const jlen = mod._teptris_wasm_json_len();
      value = JSON.parse(
        utf8.decode(mod.HEAPU8.subarray(jptr, jptr + jlen)));
      mod._teptris_wasm_free(jptr);
    } else {
      error = {
        message: UTF8ToString(mod._teptris_wasm_last_error()),
        line: mod._teptris_wasm_last_error_line(),
        column: mod._teptris_wasm_last_error_column(),
        status: st,
      };
    }
    freeCstr(mod, ptr);
    if (error) {
      const e = new Error(
        `${error.message} (line ${error.line}, column ${error.column})`);
      e.line = error.line;
      e.column = error.column;
      throw e;
    }
    return value;
  }

  function buildTree(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new TypeError("dump expects a table object (TOML roots are tables)");
    }
    const b = mod._teptris_wasm_builder_new();
    const errs = [];
    // the root table is implicit: entries attach directly
    for (const [k, item] of Object.entries(obj)) {
      buildValue(mod, b, k, item, errs);
    }
    if (errs.length) {
      mod._teptris_wasm_builder_free(b);
      throw errs[0];
    }
    return b;
  }

  function readOut(ptr) {
    const out = UTF8ToString(ptr);
    mod._teptris_wasm_free(ptr);
    return out;
  }

  // Fused dumps: the object tree is encoded ONCE into a writer
  // op-stream (Uint8Array), then a single crossing builds the TOML
  // text - no per-value builder calls, no DOM, no second walk.
  function dump(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new TypeError("dump expects a table object (TOML roots are tables)");
    }
    const enc = new TextEncoder();
    let buf = new Uint8Array(1 << 16);
    let n = 0;
    let dv = new DataView(buf.buffer);
    const ensure = (k) => {
      if (n + k <= buf.length) return;
      let cap = buf.length * 2;
      while (n + k > cap) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(buf.subarray(0, n));
      buf = nb;
      dv = new DataView(buf.buffer);
    };
    const byte = (c) => { ensure(1); buf[n++] = c; };
    const u32 = (v) => {
      ensure(4);
      dv.setUint32(n, v, true);
      n += 4;
    };
    const i64 = (v) => {
      ensure(8);
      if (v >= -2147483648 && v <= 2147483647) {
        dv.setInt32(n, v, true);
        dv.setInt32(n + 4, v < 0 ? -1 : 0, true);
      } else {
        dv.setBigInt64(n, BigInt(v), true);
      }
      n += 8;
    };
    const f64 = (d) => {
      ensure(8);
      dv.setFloat64(n, d, true);
      n += 8;
    };
    const wkey = (k) => {
      ensure(2 + k.length * 3);
      buf[n++] = 1;
      const { written } = enc.encodeInto(k, buf.subarray(n + 1));
      buf[n] = written;
      n += 1 + written;
    };
    const scalar = (k, v) => {
      if (k === null) { ensure(2); buf[n++] = 1; buf[n++] = 0; }
      else wkey(k);
      if (typeof v === "boolean") { byte(v ? 6 : 5); return; }
      if (typeof v === "number") {
        if (Number.isInteger(v)) { byte(3); i64(v); }
        else { byte(4); f64(v); }
        return;
      }
      if (typeof v === "bigint") { byte(3); i64(v); return; }
      if (typeof v === "string") {
        if (maybeRfc3339(v) && RFC3339.test(v)) {
          const dt = parseDateTime(v);
          wkey(k);
          ensure(27);
          buf[n++] = 7;
          buf[n++] = dt.kind;
          i64(dt.year);
          buf[n++] = dt.month; buf[n++] = dt.day; buf[n++] = dt.hour;
          buf[n++] = dt.minute; buf[n++] = dt.second;
          u32(dt.nanosecond);
          i64(dt.offset_seconds);
          return;
        }
        ensure(5 + v.length * 3);
        buf[n++] = 2;
        const { written } = enc.encodeInto(v, buf.subarray(n + 4));
        dv.setUint32(n, written, true);
        n += 4 + written;
        return;
      }
      throw new Error("null/undefined cannot round-trip through TOML");
    };
    const isScalar = (v) =>
      v !== null && (typeof v !== "object" || Array.isArray(v) === false &&
        (typeof v === "string" || typeof v === "number" ||
         typeof v === "boolean" || typeof v === "bigint"));
    const members = (o, inline) => {
      const keys = Object.keys(o);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], v = o[k];
        if (isScalar(v)) scalar(k, v);
      }
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], v = o[k];
        if (isScalar(v)) continue;
        if (v === null || v === undefined) {
          throw new Error("null/undefined cannot round-trip through TOML");
        }
        wkey(k);
        if (Array.isArray(v)) {
          const aot = v.length > 0 && !inline && v.every(
            (x) => x !== null && typeof x === "object" &&
              !Array.isArray(x));
          if (aot) {
            byte(0x0A);
            for (const el of v) { byte(8); members(el, true); byte(0x0C); }
            byte(0x0C);
          } else {
            byte(0x09);
            for (const el of v) arrayVal(el);
            byte(0x0C);
          }
        } else {
          byte(inline ? 0x0B : 0x08);
          members(v, inline);
          byte(0x0C);
        }
      }
    };
    const arrayVal = (el) => {
      if (isScalar(el)) { scalar(null, el); return; }
      if (Array.isArray(el)) {
        byte(0x09);
        for (const x of el) arrayVal(x);
        byte(0x0C);
        return;
      }
      if (el === null || el === undefined) {
        throw new Error("null/undefined cannot round-trip through TOML");
      }
      byte(0x0B);
      members(el, true);
      byte(0x0C);
    };
    members(obj, false);
    byte(0x00);
    const ptr = mod._teptris_wasm_alloc(n);
    mod.HEAPU8.set(buf.subarray(0, n), ptr);
    const st = mod._teptris_wasm_dump_ops(ptr, n);
    mod._teptris_wasm_free(ptr);
    if (st !== 0) {
      throw new Error(`dump failed (status ${st})`);
    }
    return readOut(mod._teptris_wasm_toml());
  }

  // Natural JSON (engine 0.3.0): real numbers, booleans, RFC 3339
  // datetime strings; non-finite floats become null. The string a
  // host can hand straight to JSON consumers.
  function dumpJson(obj) {
    const b = buildTree(obj);
    try {
      const st = mod._teptris_wasm_builder_finish_json_natural(b);
      if (st !== 0) {
        throw new Error(`dumpJson failed (status ${st})`);
      }
      return readOut(mod._teptris_wasm_toml());
    } finally {
      mod._teptris_wasm_builder_free(b);
    }
  }

  // native-doc API: the retained document. loadsDoc parses and HOLDS
  // the engine document in the module (a later loadsDoc replaces it -
  // single slot); dumpDoc emits it with the C emitter. The roundtrip
  // dumpDoc(loadsDoc(s)) runs at C speed, no JS objects materialized.
  let docHeld = false;
  function loadsDoc(toml) {
    if (typeof toml !== "string") {
      throw new TypeError("loadsDoc expects a string");
    }
    const ptr = cstr(mod, toml);
    const st = mod._teptris_wasm_load_doc(ptr, lengthBytesUTF8(toml));
    freeCstr(mod, ptr);
    if (st !== 0) {
      docHeld = false;
      const e = new Error(
        `${UTF8ToString(mod._teptris_wasm_last_error())} (line ` +
        `${mod._teptris_wasm_last_error_line()}, column ` +
        `${mod._teptris_wasm_last_error_column()})`);
      e.line = mod._teptris_wasm_last_error_line();
      e.column = mod._teptris_wasm_last_error_column();
      throw e;
    }
    docHeld = true;
    return { toString() { return "[teptris doc]"; } };
  }

  function dumpDoc(doc) {
    if (!docHeld || doc == null || typeof doc !== "object") {
      throw new Error("dumpDoc expects the document from loadsDoc " +
        "(a later loadsDoc replaces it - single slot)");
    }
    const st = mod._teptris_wasm_dump_doc();
    if (st !== 0) {
      throw new Error(UTF8ToString(mod._teptris_wasm_last_error()));
    }
    return readOut(mod._teptris_wasm_toml());
  }

  function engineVersion() {
    return UTF8ToString(mod._teptris_version_string());
  }

  // ---- descriptor plans: compile once, materialize only planned keys

  function planError() {
    const e = new Error(UTF8ToString(mod._teptris_wasm_last_error()));
    e.line = mod._teptris_wasm_last_error_line();
    e.column = mod._teptris_wasm_last_error_column();
    return e;
  }

  // rows: "name" (scalar) | { name, kind: "collection" | "raw" } |
  // { name, rows: [...] } (nested). Returns an opaque plan handle.
  function planBuild(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new TypeError("planBuild expects a non-empty array of rows");
    }
    const flat = []; // { np, kind, sub }
    const first = [0];
    const namePtrs = [];
    const pending = []; // [flatSlot, children]
    for (const r of rows) {
      const name = typeof r === "string" ? r : r.name;
      let kind = 1; // scalar
      if (typeof r === "object" && Array.isArray(r.rows)) {
        kind = 3; // nested — sub patched after the child block
        const slot = flat.length;
        const np = mod._teptris_wasm_alloc(name.length + 1);
        stringToUTF8(name, np, name.length + 1);
        namePtrs.push(np);
        flat.push({ np, kind, sub: 0 });
        pending.push([slot, r.rows]);
      } else {
        if (typeof r === "object" && r.kind === "collection") kind = 2;
        else if (typeof r === "object" && r.kind === "raw") kind = 4;
        const np = mod._teptris_wasm_alloc(name.length + 1);
        stringToUTF8(name, np, name.length + 1);
        namePtrs.push(np);
        flat.push({ np, kind, sub: 0 });
      }
    }
    // parent rows first; sub-plans laid out after them (first[] grows
    // in plan order — the C layout contract). SIBLING nested rows must
    // not capture the same index: patch sub after each child block.
    for (const [slot, children] of pending) {
      first.push(flat.length);
      flattenInto(children, flat, first, namePtrs, pending);
      flat[slot].sub = first.length - 1;
    }
    // the end sentinel for the last plan (first[] has plan_count+1
    // entries — its absence made every sub index point past the end)
    first.push(flat.length);
    const namesBuf = mod._teptris_wasm_alloc(4 * flat.length);
    const kindsBuf = mod._teptris_wasm_alloc(flat.length);
    const subsBuf = mod._teptris_wasm_alloc(4 * flat.length);
    const firstBuf = mod._teptris_wasm_alloc(4 * first.length);
    flat.forEach((f, i) => {
      mod._teptris_wasm_poke_u32(namesBuf, i, f.np);
      mod._teptris_wasm_poke_u8(kindsBuf, i, f.kind);
      mod._teptris_wasm_poke_u32(subsBuf, i, f.sub);
    });
    first.forEach((v, i) => mod._teptris_wasm_poke_u32(firstBuf, i, v));
    const plan = mod._teptris_wasm_plan_build(
      namesBuf, kindsBuf, subsBuf, flat.length, firstBuf, first.length);
    namePtrs.forEach((np) => mod._teptris_wasm_free(np));
    mod._teptris_wasm_free(namesBuf);
    mod._teptris_wasm_free(kindsBuf);
    mod._teptris_wasm_free(subsBuf);
    mod._teptris_wasm_free(firstBuf);
    if (!plan) {
      throw planError();
    }
    return plan;
  }

  function flattenInto(rows, flat, first, namePtrs, pending) {
    const slots = []; // [flatSlot, children]
    for (const r of rows) {
      const name = typeof r === "string" ? r : r.name;
      let kind = 1;
      if (typeof r === "object" && Array.isArray(r.rows)) {
        kind = 3;
        const slot = flat.length;
        const np = mod._teptris_wasm_alloc(name.length + 1);
        stringToUTF8(name, np, name.length + 1);
        namePtrs.push(np);
        flat.push({ np, kind, sub: 0 });
        slots.push([slot, r.rows]);
      } else {
        if (typeof r === "object" && r.kind === "collection") kind = 2;
        else if (typeof r === "object" && r.kind === "raw") kind = 4;
        const np = mod._teptris_wasm_alloc(name.length + 1);
        stringToUTF8(name, np, name.length + 1);
        namePtrs.push(np);
        flat.push({ np, kind, sub: 0 });
      }
    }
    for (const [slot, children] of slots) {
      first.push(flat.length);
      flattenInto(children, flat, first, namePtrs, pending);
      flat[slot].sub = first.length - 1;
    }
  }

  function planWalk(plan, toml) {
    if (typeof toml !== "string") {
      throw new TypeError("planWalk expects a TOML string");
    }
    const p = cstr(mod, toml);
    const st = mod._teptris_wasm_plan_walk(plan, p, lengthBytesUTF8(toml));
    freeCstr(mod, p);
    if (st !== 0) {
      throw planError();
    }
    const jptr = mod._teptris_wasm_json();
    const value = JSON.parse(UTF8ToString(jptr));
    mod._teptris_wasm_free(jptr);
    return value;
  }

  function planFree(plan) {
    mod._teptris_wasm_plan_free(plan);
  }

  return { loads, dump, dumpJson, planBuild, planWalk, planFree, loadsDoc, dumpDoc, engineVersion };
}

// The consumer entry: instantiate the engine once, get the API.
//   const teptris = await init();
//   teptris.loads("a = 1");
export async function init() {
  const mod = await createModule();
  return initApi(mod);
}

export default init;
