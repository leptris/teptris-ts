/* The wasm surface: one contained bridge over the zero-copy core.
 * Input bytes are copied INTO the wasm heap; the document's views live
 * inside the heap for the duration of the call; the JSON answer leaves
 * before the document is freed. The host never holds a heap pointer
 * past the call - the C buffer-lifetime contract stays internal. */
#include <emscripten/emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "teptris/teptris.h"

static char *g_json;
static size_t g_json_len;

static char last_error[256];
static int last_error_line;
static int last_error_column;

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_load(const char *data, size_t len) {
    teptris_document *doc = NULL;
    teptris_status st = teptris_parse(data, len, NULL, &doc);
    if (st != TEPTRIS_OK || doc == NULL) {
        if (doc != NULL) {
            /* read the error BEFORE the free - it points into the doc */
            const teptris_error *e = teptris_document_error(doc);
            snprintf(last_error, sizeof last_error, "%s", e->message);
            last_error_line = (int)e->line;
            last_error_column = (int)e->column;
            teptris_document_free(doc);
        } else {
            snprintf(last_error, sizeof last_error, "parse failed");
            last_error_line = 0;
            last_error_column = 0;
        }
        return (int)st;
    }
    st = teptris_document_emit_json_natural(doc, &g_json, &g_json_len);
    teptris_document_free(doc);
    return (int)st;
}

EMSCRIPTEN_KEEPALIVE
const char *teptris_wasm_last_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_last_error_line(void) { return last_error_line; }

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_last_error_column(void) { return last_error_column; }

EMSCRIPTEN_KEEPALIVE
const char *teptris_wasm_json(void) { return g_json; }

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_json_len(void) { return (int)g_json_len; }

EMSCRIPTEN_KEEPALIVE
void teptris_wasm_free(void *p) { free(p); }

/* JS-side allocations MUST go through the same allocator as free()
 * above: force-exporting _malloc alongside ASAN's own malloc/free
 * splits the heap across two allocators and every free misreports. */
EMSCRIPTEN_KEEPALIVE
void *teptris_wasm_alloc(size_t n) { return malloc(n); }

/* ---- builder surface (the dump side) ----------------------------- *
 * 1:1 with teptris_builder_*: the JS wrapper drives the same stack
 * discipline (open/close, NULL key = array element) the C and Rust
 * bindings use, so the emitter stays the single formatting truth. */

EMSCRIPTEN_KEEPALIVE
void *teptris_wasm_builder_new(void) { return teptris_builder_new(); }

EMSCRIPTEN_KEEPALIVE
void teptris_wasm_builder_free(void *b) { teptris_builder_free(b); }

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_put_string(void *b, const char *key,
                                    const char *val) {
    return teptris_builder_put_string(b, key, key ? strlen(key) : 0,
                                      val, strlen(val));
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_put_integer(void *b, const char *key,
                                     int64_t v) {
    return teptris_builder_put_integer(b, key, key ? strlen(key) : 0, v);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_put_float(void *b, const char *key, double v) {
    return teptris_builder_put_float(b, key, key ? strlen(key) : 0, v);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_put_boolean(void *b, const char *key, int v) {
    return teptris_builder_put_boolean(b, key, key ? strlen(key) : 0,
                                       v != 0);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_put_datetime(void *b, const char *key, int kind,
                                      int32_t year, uint8_t month,
                                      uint8_t day, uint8_t hour,
                                      uint8_t minute, uint8_t second,
                                      uint32_t nanosecond,
                                      int32_t offset_seconds) {
    teptris_datetime dt = {year, month, day, hour, minute, second,
                           nanosecond, offset_seconds};
    return teptris_builder_put_datetime(
        b, key, key ? strlen(key) : 0, (teptris_kind)kind, &dt);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_open_table(void *b, const char *key) {
    return teptris_builder_open_table(b, key, key ? strlen(key) : 0);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_open_array(void *b, const char *key) {
    return teptris_builder_open_array(b, key, key ? strlen(key) : 0);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_close(void *b) {
    return teptris_builder_close(b);
}

/* finish -> emit into a global buffer (same accessor pattern as the
 * parse-side JSON): the dump path offers canonical TOML and the
 * host-facing natural JSON (engine 0.3.0). */
static char *g_toml;
static size_t g_toml_len;

/* native-doc API: the retained DOM. loads_doc parses and HOLDS the
 * engine document in a single slot (a later load replaces and frees
 * it); dump_doc emits it with the C emitter. The roundtrip
 * dumpDoc(loadsDoc(s)) runs at C speed - no JS objects materialized.
 * Single-threaded, single-slot by contract. */
static teptris_document *g_doc;
/* the doc's keys/values are VIEWS into its parse input - the input
 * buffer must live as long as the retained document */
static char *g_doc_input;

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_load_doc(const char *data, size_t len) {
    if (g_doc != NULL) {
        teptris_document_free(g_doc);
        g_doc = NULL;
    }
    if (g_doc_input != NULL) {
        free(g_doc_input);
        g_doc_input = NULL;
    }
    /* copy the input FIRST: the doc's keys/values are views into it,
     * and the caller's buffer is transient */
    char *input = malloc(len);
    if (input == NULL) {
        snprintf(last_error, sizeof last_error, "alloc failed");
        return (int)TEPTRIS_ERR_ALLOC;
    }
    memcpy(input, data, len);
    teptris_document *doc = NULL;
    teptris_status st = teptris_parse(input, len, NULL, &doc);
    if (st != TEPTRIS_OK || doc == NULL) {
        free(input);
        if (doc != NULL) {
            const teptris_error *e = teptris_document_error(doc);
            snprintf(last_error, sizeof last_error, "%s", e->message);
            last_error_line = (int)e->line;
            last_error_column = (int)e->column;
            teptris_document_free(doc);
        } else {
            snprintf(last_error, sizeof last_error, "parse failed");
        }
        return (int)st;
    }
    g_doc_input = input;
    g_doc = doc;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_dump_doc(void) {
    if (g_doc == NULL) {
        snprintf(last_error, sizeof last_error,
                 "no retained document (loadsDoc first)");
        return (int)TEPTRIS_ERR_STATE;
    }
    char *buf = NULL;
    size_t len = 0;
    teptris_status st = teptris_document_emit(g_doc, &buf, &len);
    if (st != TEPTRIS_OK) {
        snprintf(last_error, sizeof last_error, "%s",
                 teptris_status_string(st));
        return (int)st;
    }
    /* no free(g_toml) here: the JS readOut() frees the pointer it
     * read (the builder_finish convention) - freeing it here too is a
     * double free */
    g_toml = buf;
    g_toml_len = len;
    return 0;
}

/* fused dumps: the JS side encodes one op-stream (writer grammar),
 * this builds TOML in one crossing - no per-value builder calls, no
 * DOM */
EMSCRIPTEN_KEEPALIVE
int teptris_wasm_dump_ops(const uint8_t *ops, size_t len) {
    teptris_writer *w = teptris_writer_new();
    if (w == NULL) {
        snprintf(last_error, sizeof last_error, "writer alloc failed");
        return (int)TEPTRIS_ERR_ALLOC;
    }
    teptris_status st = teptris_writer_feed(w, ops, len);
    if (st == TEPTRIS_OK) {
        st = teptris_writer_finish(w, &g_toml, &g_toml_len);
    } else {
        teptris_writer_free(w);
        snprintf(last_error, sizeof last_error, "%s",
                 teptris_status_string(st));
        return (int)st;
    }
    teptris_writer_free(w);
    if (st != TEPTRIS_OK) {
        snprintf(last_error, sizeof last_error, "%s",
                 teptris_status_string(st));
    }
    return (int)st;
}


static int finish_with(void *b,
                       teptris_status (*emit)(const teptris_document *,
                                              char **, size_t *)) {
    teptris_document *doc = NULL;
    teptris_status st = teptris_builder_finish(b, &doc);
    if (st != TEPTRIS_OK) {
        return (int)st;
    }
    char *buf = NULL;
    size_t len = 0;
    st = emit(doc, &buf, &len);
    teptris_document_free(doc);
    if (st != TEPTRIS_OK) {
        return (int)st;
    }
    g_toml = buf;
    g_toml_len = len;
    return TEPTRIS_OK;
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_finish(void *b) {
    return finish_with(b, teptris_document_emit);
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_builder_finish_json_natural(void *b) {
    return finish_with(b, teptris_document_emit_json_natural);
}

EMSCRIPTEN_KEEPALIVE
const char *teptris_wasm_toml(void) { return g_toml; }

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_toml_len(void) { return (int)g_toml_len; }

/* ------------------------------------------------ descriptor plans -- *
 * Plan an once, walk many documents: only the planned keys are
 * materialized (the engine plan API). The JS side flattens the plan
 * tree honoring plan p's contiguous range [first[p], first[p+1]) and
 * passes parallel arrays; materialization goes through the builder so
 * the emitter stays the single formatting truth, and RAW rows re-use
 * the plain node accessors. */

#include "teptris/plan.h"

EMSCRIPTEN_KEEPALIVE
void *teptris_wasm_plan_build(const char **names, const uint8_t *kinds,
                              const uint32_t *subs, uint32_t nrows,
                              const uint32_t *first, uint32_t nfirst) {
    if (nrows == 0 || nfirst < 2) {
        snprintf(last_error, sizeof last_error, "plan needs rows");
        return NULL;
    }
    teptris_plan_row *rows = malloc(nrows * sizeof *rows);
    if (rows == NULL) {
        return NULL;
    }
    for (uint32_t i = 0; i < nrows; i++) {
        rows[i].name = names[i];
        rows[i].kind = kinds[i];
        rows[i].sub = subs[i];
    }
    teptris_plan_spec spec;
    spec.abi_version = TEPTRIS_PLAN_ABI_VERSION;
    spec.plan_count = nfirst - 1;
    spec.plans = rows;
    spec.plan_first_row = first;
    teptris_status st;
    teptris_plan *p = teptris_plan_build(&spec, &st);
    free(rows);
    if (st != TEPTRIS_OK) {
        snprintf(last_error, sizeof last_error, "plan build failed (%s)",
                 teptris_status_string(st));
        return NULL;
    }
    return p;
}

EMSCRIPTEN_KEEPALIVE
void teptris_wasm_plan_free(teptris_plan *plan) { teptris_plan_free(plan); }

/* JS cannot write typed memory without heap views (which detach on
 * memory growth) — two trivial pokes keep plan-spec assembly on the
 * C side of the line. */
EMSCRIPTEN_KEEPALIVE
void teptris_wasm_poke_u32(uint32_t *p, uint32_t i, uint32_t v) {
    p[i] = v;
}

EMSCRIPTEN_KEEPALIVE
void teptris_wasm_poke_u8(uint8_t *p, uint32_t i, uint8_t v) {
    p[i] = v;
}

static int put_scalar_result(teptris_builder *b, const char *key,
                             const teptris_plan_result *res, uint32_t i) {
    teptris_datetime dt;
    switch (teptris_plan_result_value_kind_at(res, i)) {
    case TEPTRIS_STRING: {
        teptris_view v;
        if (teptris_plan_result_string_at(res, i, &v) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_string(b, key, strlen(key), v.ptr, v.len)
               != TEPTRIS_OK;
    }
    case TEPTRIS_INTEGER: {
        int64_t iv;
        if (teptris_plan_result_integer_at(res, i, &iv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_integer(b, key, strlen(key), iv)
               != TEPTRIS_OK;
    }
    case TEPTRIS_FLOAT: {
        double dv;
        if (teptris_plan_result_float_at(res, i, &dv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_float(b, key, strlen(key), dv) != TEPTRIS_OK;
    }
    case TEPTRIS_BOOLEAN: {
        bool bv;
        if (teptris_plan_result_boolean_at(res, i, &bv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_boolean(b, key, strlen(key), bv)
               != TEPTRIS_OK;
    }
    case TEPTRIS_DATETIME_OFFSET:
    case TEPTRIS_DATETIME_LOCAL:
    case TEPTRIS_DATE_LOCAL:
    case TEPTRIS_TIME_LOCAL:
        if (teptris_plan_result_datetime_at(res, i, &dt) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_datetime(b, key, strlen(key),
                                            (teptris_kind)teptris_plan_result_value_kind_at(
                                                res, i),
                                            &dt)
               != TEPTRIS_OK;
    default:
        return 1;
    }
}

static int put_array_scalar_result(teptris_builder *b,
                                   const teptris_plan_result *res, uint32_t i,
                                   uint32_t j) {
    teptris_datetime dt;
    switch (teptris_plan_result_array_value_kind_at(res, i, j)) {
    case TEPTRIS_STRING: {
        teptris_view v;
        if (teptris_plan_result_array_string_at(res, i, j, &v) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_string(b, NULL, 0, v.ptr, v.len)
               != TEPTRIS_OK;
    }
    case TEPTRIS_INTEGER: {
        int64_t iv;
        if (teptris_plan_result_array_integer_at(res, i, j, &iv)
            != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_integer(b, NULL, 0, iv) != TEPTRIS_OK;
    }
    case TEPTRIS_FLOAT: {
        double dv;
        if (teptris_plan_result_array_float_at(res, i, j, &dv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_float(b, NULL, 0, dv) != TEPTRIS_OK;
    }
    case TEPTRIS_BOOLEAN: {
        bool bv;
        if (teptris_plan_result_array_boolean_at(res, i, j, &bv)
            != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_boolean(b, NULL, 0, bv) != TEPTRIS_OK;
    }
    case TEPTRIS_DATETIME_OFFSET:
    case TEPTRIS_DATETIME_LOCAL:
    case TEPTRIS_DATE_LOCAL:
    case TEPTRIS_TIME_LOCAL:
        if (teptris_plan_result_array_datetime_at(res, i, j, &dt)
            != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_datetime(b, NULL, 0,
                                            (teptris_kind)teptris_plan_result_array_value_kind_at(
                                                res, i, j),
                                            &dt)
               != TEPTRIS_OK;
    default:
        return 1;
    }
}

static int put_node(teptris_builder *b, const char *key, size_t klen,
                    const teptris_node *n);

static int put_node_array(teptris_builder *b, const char *key,
                          const teptris_node *n) {
    if (teptris_builder_open_array(b, key, key ? strlen(key) : 0)
        != TEPTRIS_OK) {
        snprintf(last_error, sizeof last_error,
                 "plan asm: open_array failed");
        return 1;
    }
    size_t n2 = teptris_node_array_length(n);
    for (size_t j = 0; j < n2; j++) {
            if (put_node(b, NULL, 0, teptris_node_array_at(n, j)) != 0) {
            snprintf(last_error, sizeof last_error,
                     "plan asm: array elem %zu put_node failed", (size_t)j);
            return 1;
        }
    }
    if (teptris_builder_close(b) != TEPTRIS_OK) {
        snprintf(last_error, sizeof last_error,
                 "plan asm: close array failed");
        return 1;
    }
    return 0;
}

static int put_node(teptris_builder *b, const char *key, size_t klen,
                    const teptris_node *n) {
    teptris_view v;
    int64_t iv;
    double dv;
    bool bv;
    teptris_datetime dt;
    switch (teptris_node_kind(n)) {
    case TEPTRIS_STRING:
        if (teptris_node_string(n, &v) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_string(b, key, klen, v.ptr, v.len)
               != TEPTRIS_OK;
    case TEPTRIS_INTEGER:
        if (teptris_node_integer(n, &iv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_integer(b, key, klen, iv) != TEPTRIS_OK;
    case TEPTRIS_FLOAT:
        if (teptris_node_float(n, &dv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_float(b, key, klen, dv) != TEPTRIS_OK;
    case TEPTRIS_BOOLEAN:
        if (teptris_node_boolean(n, &bv) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_boolean(b, key, klen, bv ? 1 : 0)
               != TEPTRIS_OK;
    case TEPTRIS_DATETIME_OFFSET:
    case TEPTRIS_DATETIME_LOCAL:
    case TEPTRIS_DATE_LOCAL:
    case TEPTRIS_TIME_LOCAL:
        if (teptris_node_datetime(n, &dt) != TEPTRIS_OK) {
            return 1;
        }
        return teptris_builder_put_datetime(b, key, klen,
                                            teptris_node_kind(n), &dt)
               != TEPTRIS_OK;
    case TEPTRIS_TABLE: {
        if (teptris_builder_open_table(b, key, klen) != TEPTRIS_OK) {
            snprintf(last_error, sizeof last_error,
                     "plan asm: open_table failed (klen %zu)", klen);
            return 1;
        }
        size_t n2 = teptris_node_table_length(n);
        for (size_t j = 0; j < n2; j++) {
            teptris_view child_key;
            const teptris_node *child =
                teptris_node_table_at(n, j, &child_key);
            if (child != NULL
                && put_node(b, child_key.ptr, child_key.len, child) != 0) {
                snprintf(last_error, sizeof last_error,
                         "plan asm: table child %zu put_node failed",
                         (size_t)j);
                return 1;
            }
        }
        if (teptris_builder_close(b) != TEPTRIS_OK) {
            snprintf(last_error, sizeof last_error,
                     "plan asm: close table failed");
            return 1;
        }
        return 0;
    }
    case TEPTRIS_ARRAY:
        return put_node_array(b, key, n);
    default:
        return 1;
    }
}

static int asm_table_rows(teptris_builder *b, const teptris_plan *p,
                          const teptris_plan_result *res, uint32_t plan_idx);

static int asm_table_rows(teptris_builder *b, const teptris_plan *p,
                          const teptris_plan_result *res, uint32_t plan_idx) {
    uint32_t n = teptris_plan_row_count(p, plan_idx);
    for (uint32_t i = 0; i < n; i++) {
        uint8_t kind = teptris_plan_result_kind_at(res, i);
        if (kind == 0 /* MISSING */) {
            continue;
        }
        const char *key = teptris_plan_row_name_at(p, plan_idx, i);
        switch (kind) {
        case 1 /* SCALAR */:
            if (put_scalar_result(b, key, res, i) != 0) {
                return 1;
            }
            break;
        case 2 /* ARRAY */: {
            uint32_t n2 = teptris_plan_result_array_len_at(res, i);
            uint32_t sub = teptris_plan_row_sub_at(p, plan_idx, i);
            if (teptris_builder_open_array(b, key, strlen(key)) != TEPTRIS_OK) {
                return 1;
            }
            for (uint32_t j = 0; j < n2; j++) {
                if (teptris_plan_result_array_kind_at(res, i, j) == 3 /* TABLE */) {
                    teptris_plan_result *entry =
                        teptris_plan_result_array_entry_at(res, i, j);
                    if (entry == NULL) {
                        return 1;
                    }
                    int rc = asm_table_rows(b, p, entry, sub);
                    teptris_plan_result_view_free(entry);
                    if (rc != 0) {
                        return 1;
                    }
                } else if (put_array_scalar_result(b, res, i, j) != 0) {
                    return 1;
                }
            }
            if (teptris_builder_close(b) != TEPTRIS_OK) {
                return 1;
            }
            break;
        }
        case 3 /* TABLE */: {
            teptris_plan_result *sub = teptris_plan_result_row_view(res, i);
            if (sub == NULL) {
                return 1;
            }
            uint32_t sub_idx = teptris_plan_row_sub_at(p, plan_idx, i);
            if (teptris_builder_open_table(b, key, strlen(key))
                != TEPTRIS_OK) {
                return 1;
            }
            int rc = asm_table_rows(b, p, sub, sub_idx);
            teptris_plan_result_view_free(sub);
            if (rc != 0 || teptris_builder_close(b) != TEPTRIS_OK) {
                return 1;
            }
            break;
        }
        case 4 /* RAW */: {
            const teptris_node *raw = teptris_plan_result_raw_at(res, i);
            if (raw == NULL) {
                snprintf(last_error, sizeof last_error,
                         "plan asm: raw row %u has no node", (unsigned)i);
                return 1;
            }
            /* put_node sets its own specific message */
            if (put_node(b, key, strlen(key), raw) != 0) {
                return 1;
            }
            break;
            break;
        }
        default:
            snprintf(last_error, sizeof last_error,
                     "plan asm: row %u unexpected kind %d", (unsigned)i,
                     (int)kind);
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int teptris_wasm_plan_walk(void *plan, const char *data, size_t len) {
    teptris_document *doc = NULL;
    teptris_status st = teptris_parse(data, len, NULL, &doc);
    if (st != TEPTRIS_OK || doc == NULL) {
        if (doc != NULL) {
            const teptris_error *e = teptris_document_error(doc);
            snprintf(last_error, sizeof last_error, "%s", e->message);
            last_error_line = (int)e->line;
            last_error_column = (int)e->column;
            teptris_document_free(doc);
        } else {
            snprintf(last_error, sizeof last_error, "parse failed");
        }
        return (int)st;
    }
    teptris_status wst;
    teptris_plan_result *res = teptris_plan_walk(
        (const teptris_plan *)plan, teptris_document_root(doc), &wst);
    if (wst != TEPTRIS_OK || res == NULL) {
        snprintf(last_error, sizeof last_error, "plan walk failed (%s)",
                 teptris_status_string(wst));
        teptris_document_free(doc);
        return (int)wst;
    }
    teptris_builder *b = teptris_builder_new();
    int rc = 0;
    if (b == NULL) {
        snprintf(last_error, sizeof last_error,
                 "plan materialize: out of memory");
        rc = TEPTRIS_ERR_STATE;
    } else if (asm_table_rows(b, (const teptris_plan *)plan, res, 0) != 0) {
        /* asm_table_rows set last_error with the failing row */
        rc = TEPTRIS_ERR_STATE;
    }
    if (rc == 0) {
        teptris_document *out = NULL;
        st = teptris_builder_finish(b, &out);
        teptris_builder_free(b);
        if (st != TEPTRIS_OK) {
            teptris_document_free(out);
            teptris_document_free(doc);
            teptris_plan_result_free(res);
            return (int)st;
        }
        char *buf = NULL;
        size_t blen = 0;
        st = teptris_document_emit_json_natural(out, &buf, &blen);
        teptris_document_free(out);
        if (st != TEPTRIS_OK) {
            teptris_document_free(doc);
            teptris_plan_result_free(res);
            return (int)st;
        }
        g_json = buf;
        g_json_len = blen;
    } else {
        teptris_builder_free(b);
    }
    teptris_plan_result_free(res);
    teptris_document_free(doc);
    return rc;
}
