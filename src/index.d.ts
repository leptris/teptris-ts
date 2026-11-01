/**
 * teptris — TOML 1.1 for JavaScript/TypeScript at libteptris
 * speed (WebAssembly, no fallback).
 *
 *   const teptris = await init();
 *   const doc = teptris.loads('title = "demo"');
 *   const toml = teptris.dump(doc);
 *   const json = teptris.dumpJson(doc);
 */

/** A parsed TOML value: datetimes are RFC 3339 strings, non-finite
 *  floats (nan/inf) are null. */
export type TomlValue =
  | string
  | number
  | boolean
  | null
  | TomlTable
  | TomlValue[];

/** A TOML table: string keys, insertion-ordered. */
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Parse errors carry the engine's line/column (1-based). */
export interface TeptrisError extends Error {
  line: number;
  column: number;
}

export interface TeptrisApi {
  /** Parse TOML into a JS object (natural-JSON view: real numbers,
   *  booleans, RFC 3339 datetime strings, non-finite floats as
   *  null). Throws TeptrisError on invalid input.
   *
   *  Precision floor: JS numbers lose precision past 2^53, so
   *  integer literals beyond that round (9223372036854775807 reads
   *  back as 9223372036854776000). dump() never wraps: values past
   *  the int64 bounds emit as floats, and bigints outside int64
   *  throw.
   *
   *  Type floor: JSON numbers carry no int/float distinction, so an
   *  integral-valued float (-776571136.0) loads as a plain number and
   *  dump() re-emits it as an integer - the .0-ness is unrecoverable
   *  (py/ruby/rs keep it; their loads carry typed values). Nesting
   *  past the engine's 512 ceiling dumps with a named
   *  'nesting too deep' error. */
  loads(toml: string): TomlTable;

  /** Serialize a table to canonical TOML via the engine builder.
   *  RFC 3339 strings re-enter as datetimes. Throws TypeError for
   *  non-table roots, Error for unsupported values. */
  dump(value: TomlTable): string;

  /** Serialize a table to natural JSON (the engine's fastest emit
   *  mode): real numbers, booleans, RFC 3339 datetime strings,
   *  non-finite floats as null. */
  dumpJson(value: TomlTable): string;

  /** The libteptris engine version inside this build. */
  engineVersion(): string;

  /** Parse TOML into a retained engine document (no host objects):
   *  the LOSSLESS round-trip surface. JS numbers cannot carry TOML's
   *  int/float distinction (loads' documented floor) - doc handles
   *  can: dumpDoc(loadsDoc(s)) re-emits the parsed tree exactly, at
   *  C speed with nothing materialized in JS. Single slot: a later
   *  loadsDoc replaces the held document. */
  loadsDoc(toml: string): TeptrisDoc;

  /** Emit a loadsDoc() document back to canonical TOML — the
   *  lossless half of the doc round-trip. */
  dumpDoc(doc: TeptrisDoc): string;

  /** Format-preserving edit: rewrite exactly the value bytes of one
   *  key = value line; every other byte of the source survives
   *  (comments, blank lines, formatting, CRLF endings). keyPath may
   *  carry a [table] prefix ("t.x" edits x inside [t]); a dotted key
   *  line may continue the open section. replacement is the value's
   *  TEXT, validated by the engine; multiline strings and inline
   *  collections splice (parse-verified). Throws Error on an absent
   *  key or a malformed span/replacement. */
  edit(source: string, keyPath: string, replacement: string): string;

  /** Compile a descriptor plan (once) — materialize only the planned
   *  keys of any document via planWalk. Rows: a string name is a
   *  scalar; kind "collection" walks an array; kind "raw" takes the
   *  untouched subtree; rows: [...] walks a nested table. */
  planBuild(rows: PlanRowSpec[]): number;

  /** Walk one TOML document against the plan; returns only the
   *  planned keys (natural shapes: RFC 3339 datetime strings,
   *  non-finite floats as null). Throws on parse/plan errors. */
  planWalk(plan: number, toml: string): TomlTable;

  /** Release a compiled plan. */
  planFree(plan: number): void;
}

/** An opaque retained-document handle from {@link TeptrisApi.loadsDoc}
 *  (single slot: a later loadsDoc replaces the held document). */
export interface TeptrisDoc {
  /** Renders "[teptris doc]". */
  toString(): string;
}

/** One planned key of a {@link PlanRowSpec} tree. */
export interface PlanRowSpec {
  name: string;
  kind?: "scalar" | "collection" | "raw";
  /** Nested table rows — makes this row a nested table. */
  rows?: PlanRowSpec[];
}

/** Instantiate the WebAssembly engine and return the API. */
export function init(): Promise<TeptrisApi>;

/** Advanced: wrap an already-instantiated engine module (custom
 *  instantiation, browser bundlers with special wasm loading). */
export function initApi(mod: unknown): TeptrisApi;

export default init;
