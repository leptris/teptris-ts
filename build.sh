#!/usr/bin/env bash
# Builds the ES module + wasm from the vendored engine sources.
#   ENGINESRC defaults to ../teptris/src (sibling checkout)
set -euo pipefail
cd "$(dirname "$0")"
ENGINESRC="${ENGINESRC:-../teptris/src}"
mkdir -p dist
emcc -O3 -std=c99 -Wall -Wextra \
  -I"$ENGINESRC/include" -I"$ENGINESRC" \
  src/teptris_wasm.c \
  "$ENGINESRC"/teptris/*.c \
  "$ENGINESRC"/teptris/*/*.c \
  "$ENGINESRC"/teptris/*/*/*.c \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,node \
  -s EXPORTED_RUNTIME_METHODS="['UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8']" \
  -s EXPORTED_FUNCTIONS='["_teptris_wasm_load","_teptris_wasm_json","_teptris_wasm_json_len","_teptris_wasm_last_error","_teptris_wasm_last_error_line","_teptris_wasm_last_error_column","_teptris_wasm_free","_teptris_wasm_alloc","_teptris_wasm_builder_new","_teptris_wasm_builder_free","_teptris_wasm_builder_put_string","_teptris_wasm_builder_put_integer","_teptris_wasm_builder_put_float","_teptris_wasm_builder_put_boolean","_teptris_wasm_builder_put_datetime","_teptris_wasm_builder_open_table","_teptris_wasm_builder_open_array","_teptris_wasm_builder_close","_teptris_wasm_builder_finish","_teptris_wasm_toml","_teptris_wasm_toml_len","_teptris_version_string","_teptris_wasm_plan_build","_teptris_wasm_plan_free","_teptris_wasm_plan_walk","_teptris_wasm_poke_u32","_teptris_wasm_poke_u8","_teptris_wasm_dump_ops","_teptris_wasm_load_doc","_teptris_wasm_dump_doc","_teptris_wasm_edit"]' \
  -s WASM_BIGINT=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o dist/teptris.mjs
ls -la dist/
