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
