# CLAUDE.md — teptris-ts (npm: teptris)

## Mission

Be the best TOML parser and builder ever made — in C, Ruby, Rust, and
JS — measured, not claimed. This binding's bar, and the family
ledger/plan, live in the engine's
[BEST-EVER.md](https://github.com/leptris/teptris/blob/main/BEST-EVER.md).
"At parity" or "unmeasured" is an open gap. **The open JS gap: smol-toml
is only at parity — the mission requires strictly beating it on every
shape, parse and emit.**

## Operating laws (this binding)

- Version is 3-part semver (current: 0.3.7 = engine 0.3.4 line,
  iteration 7). The engine pin is `ref:` in ci.yml AND publish.yml —
  **a version bump moves both pins in the same PR**.
- Releases: dispatch publish.yml (or push a GitHub release) →
  emsdk 3.1.74 build → npm tests on the artifact → npm Trusted
  Publishing (OIDC, provenance). Verify from the registry: npm CDN
  lags minutes behind a successful publish.
- Every release is gated by a published-package smoke: install from
  npm, `init()`, `engineVersion()` == the pin, loads/dump, deep-plan
  rejection, zero console noise.
- The wasm module is built with the zero-warning gate; WASM_BIGINT=1
  is explicit (emsdk defaults drift); never force-export `_malloc`
  alongside ASAN (allocator split) — use the `wasm_alloc` bridge.
- All changes through PRs (rebase-merge); the node matrix + headless
  browser smoke gate the merge.
