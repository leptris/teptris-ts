# teptris (JavaScript/TypeScript)

**Mission: be the best TOML parser and builder ever made — in C, Ruby,
Rust, and JS — measured, not claimed.** The bar and the family ledger:
[BEST-EVER.md](https://github.com/leptris/teptris/blob/main/BEST-EVER.md).

TOML for JavaScript at libteptris speed — the engine compiled to
WebAssembly (emscripten, ES module), no fallback.

```js
import { init } from "teptris";

const teptris = await init();
teptris.loads('a = 1');               // → { a: 1 }
teptris.dump(obj);                    // → canonical TOML string
teptris.dumpJson(obj);                // → natural JSON string
teptris.engineVersion();              // → the libteptris inside
```

TypeScript ships first-class: `src/index.d.ts` types the full surface
(`init`, `TeptrisApi`, `TomlTable`, `TeptrisError` with
`line`/`column`) — strict `tsc` consumers are part of the test suite.
For custom instantiation (bundler-managed wasm loading), `initApi(mod)`
wraps an already-instantiated emscripten module.

**Surface (v1, engine 0.3.0):** `loads` uses the natural-JSON emit —
real numbers, booleans, RFC 3339 datetime strings, non-finite floats
as `null`. `dump` emits canonical TOML through the builder; `dumpJson`
emits the same tree as natural JSON — the string a host hands straight
to JSON consumers, and the engine's fastest emit mode. Errors carry
`message`/`line`/`column`.

## Performance (JS tier)

Best-of-40 on darwin/arm64, node 24, over the engine bench corpus
(`benchmark/js_tier.mjs` — runs in CI as a report-only lane):

- **vs @iarna/toml** (the ecosystem's long-standing standard): 2–4×
  faster on loads — and it rejects two corpus shapes outright (it
  still enforces a pre-1.0 single-type-array rule; the corpus is
  legal TOML 1.0).
- **vs smol-toml** (the modern fast pure-JS parser): roughly parity
  — teptris wins the datetime-heavy shapes (1.5×) and deep tables;
  smol wins scalar-string-heavy inputs, where the wasm→JS bridge
  (natural-JSON emit + `JSON.parse`) prices every string.
- **dumpJson vs `JSON.stringify`**: the native baseline is 3–6×
  faster — same verdict as the ruby/python tiers. The API's value is
  the one-pass TOML→JSON contract, not beating the platform's JSON.

The JS tier's edge is the engine's correctness: full TOML 1.1 draft
grammar and the same parse/emit behavior as the ruby, python and
rust bindings.

## Build

```sh
ENGINESRC=../teptris/src ./build.sh   # emscripten required
npm test
```

The bridge copies input bytes INTO the wasm heap; the engine's
zero-copy buffer-lifetime contract stays internal — the host never
holds a heap pointer past the call.
