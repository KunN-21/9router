// Self-check: phân loại timeout khi kiểm tra stream của combo.
// Spec: docs/superpowers/specs/2026-10-04-combo-stream-timeout-design.md
//
// Chạy source THẬT của open-sse/services/combo.js trong vm.SourceTextModule với
// linker allowlist tường minh. Không copy hàm, không regex-rewrite source, không
// thêm export test-only. Linker fail-closed: import ngoài allowlist ném lỗi.
// Dynamic import bị reject. Trong VM không có process/fs/network.
//
// Modules thật trong VM (đã audit thuần, không chạm process/fs/network/fetch):
//   - open-sse/services/accountFallback.js (chỉ import ../config/errorConfig.js)
//   - open-sse/utils/error.js (chỉ import ../config/errorConfig.js + ../config/runtimeConfig.js)
//   - open-sse/config/errorConfig.js (lá, không import gì)
// Stubs synthetic (ghi rõ ở dưới, không đọc từ disk):
//   - ../config/runtimeConfig.js: stub hằng số runtime với timeout NGẮN để timer
//     deterministic; HTTP_STATUS mirror đúng giá trị đã audit từ source thật.
//   - ../providers/capabilities.js: stub getCapabilitiesForModel trả {}; các case
//     dùng body text thuần nên detectRequiredCapabilities trả rỗng và stub không
//     ảnh hưởng kết quả.
//   - ../translator/formats/gemini.js: stub extractTextContent tối thiểu; đường
//     fusion/flatten không thuộc phạm vi spec này.
// Giới hạn: kiểm offline memory-only; không thay full integration/live runtime.

import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const COMBO_REL = path.join("open-sse", "services", "combo.js");
const COMBO_PATH = path.join(ROOT, COMBO_REL);

// ---- Literals suy ra bằng tay từ spec, không từ code under test ----
const TIMEOUT_MSG = "provider timed out waiting for stream content";
const EMPTY_MSG = "provider returned an empty stream";
const TIMEOUT_TYPE = "server_error";
const TIMEOUT_CODE = "gateway_timeout";

// ---- Source thật duy nhất được đọc từ disk (allowlist) ----
function readReal(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
const REAL = {
  combo: readReal(COMBO_REL),
  accountFallback: readReal(path.join("open-sse", "services", "accountFallback.js")),
  error: readReal(path.join("open-sse", "utils", "error.js")),
  errorConfig: readReal(path.join("open-sse", "config", "errorConfig.js")),
};

// ---- Stubs synthetic. HTTP_STATUS mirror giá trị đã audit từ
// open-sse/config/runtimeConfig.js source thật (400/401/402/403/404/406/408/429/
// 500/502/503/504). Timeout ngắn để stall tests chạy nhanh và deterministic. ----
const STUB_RUNTIME_CONFIG = `
export const FETCH_CONNECT_TIMEOUT_MS = 40;
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 40;
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};
`;
const STUB_CAPABILITIES = `
export function getCapabilitiesForModel(provider, model) { return {}; }
`;
const STUB_GEMINI = `
export function extractTextContent(content) {
  if (typeof content === "string") return content;
  return "";
}
`;

const COMBO_ID = `file://${COMBO_PATH}`;
const idOf = (rel) => `file://${path.join(ROOT, rel)}`;
const ACCT_ID = idOf(path.join("open-sse", "services", "accountFallback.js"));
const ERROR_ID = idOf(path.join("open-sse", "utils", "error.js"));
const ERRORCONFIG_ID = idOf(path.join("open-sse", "config", "errorConfig.js"));

function resolveAllowlist(from, specifier) {
  const deny = () => {
    throw new Error(`linker fail-closed: import không thuộc allowlist (from=${from} spec=${specifier})`);
  };
  if (from === COMBO_ID) {
    switch (specifier) {
      case "./accountFallback.js": return { id: ACCT_ID, source: REAL.accountFallback };
      case "../utils/error.js": return { id: ERROR_ID, source: REAL.error };
      case "../providers/capabilities.js": return { id: "stub://capabilities", source: STUB_CAPABILITIES };
      case "../config/runtimeConfig.js": return { id: "stub://runtimeConfig", source: STUB_RUNTIME_CONFIG };
      case "../translator/formats/gemini.js": return { id: "stub://gemini", source: STUB_GEMINI };
      case "../config/errorConfig.js": return { id: ERRORCONFIG_ID, source: REAL.errorConfig };
      default: deny();
    }
  }
  if (from === ACCT_ID) {
    if (specifier === "../config/errorConfig.js") return { id: ERRORCONFIG_ID, source: REAL.errorConfig };
    deny();
  }
  if (from === ERROR_ID) {
    if (specifier === "../config/errorConfig.js") return { id: ERRORCONFIG_ID, source: REAL.errorConfig };
    if (specifier === "../config/runtimeConfig.js") return { id: "stub://runtimeConfig", source: STUB_RUNTIME_CONFIG };
    deny();
  }
  deny();
}

const rejectDynamic = async () => {
  throw new Error("dynamic import bị reject trong self-check");
};

// Timer có instrument để assert cleanup: mọi timer tạo ra phải bị clear/fire.
const pendingTimers = new Set();
function trackedSetTimeout(fn, ms, ...args) {
  const t = setTimeout(() => {
    pendingTimers.delete(t);
    fn(...args);
  }, ms);
  pendingTimers.add(t);
  return t;
}
function trackedClearTimeout(t) {
  pendingTimers.delete(t);
  clearTimeout(t);
}

const sandbox = {
  Response,
  Request,
  Headers,
  ReadableStream,
  TextDecoder,
  TextEncoder,
  AbortController,
  URL,
  setTimeout: trackedSetTimeout,
  clearTimeout: trackedClearTimeout,
  console,
};
vm.createContext(sandbox);

// Giữ event loop sống trong khi peek chờ: combo unref timer của nó (đúng cho
// server), script bare-node không còn handle ref'd nào khi stream treo.
const keepalive = setInterval(() => {}, 500);

async function loadCombo() {
  const cache = new Map();
  async function linker(specifier, referencingModule) {
    const key = `${referencingModule.identifier}\n${specifier}`;
    if (cache.has(key)) return cache.get(key);
    const resolved = resolveAllowlist(referencingModule.identifier, specifier);
    const mod = new vm.SourceTextModule(resolved.source, {
      identifier: resolved.id,
      context: sandbox,
      importModuleDynamically: rejectDynamic,
    });
    cache.set(key, mod);
    await mod.link(linker);
    return mod;
  }
  const entry = new vm.SourceTextModule(REAL.combo, {
    identifier: COMBO_ID,
    context: sandbox,
    importModuleDynamically: rejectDynamic,
  });
  await entry.link(linker);
  await entry.evaluate();
  return entry.namespace;
}

// ---- Fixtures memory-only ----
const enc = new TextEncoder();

function makeLog() {
  const info = [];
  const warn = [];
  return {
    info: (t, m, d) => { info.push([t, m, d]); },
    warn: (t, m, d) => { warn.push([t, m, d]); },
    debug: () => {},
    _info: info,
    _warn: warn,
  };
}

function sseResponse(stream) {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Stream treo vĩnh viễn: read pend, chỉ settle khi timeout/abort cancel reader.
function hangingStream(hooks = {}) {
  return new ReadableStream({
    start() {},
    cancel(reason) { hooks.cancelled = true; hooks.reason = reason; },
  });
}

// Stream phát prefix rồi treo (không close).
function stallAfter(prefixText, hooks = {}) {
  return new ReadableStream({
    start(c) { c.enqueue(enc.encode(prefixText)); },
    cancel(reason) { hooks.cancelled = true; hooks.reason = reason; },
  });
}

// Stream phát chunks rồi close sạch (EOF).
function bytesStream(chunks, hooks = {}) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
    cancel(reason) { hooks.cancelled = true; hooks.reason = reason; },
  });
}

function jsonErrorResponse(status, errObj, retryAfter = null) {
  const payload = { error: errObj };
  if (retryAfter) payload.retryAfter = retryAfter;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONTENT_FRAME = 'data: {"choices":[{"delta":{"content":"hello combo"}}]}\n\n';

async function runCombo(handleComboChat, responders, models, opts = {}) {
  const attempted = [];
  const log = makeLog();
  const response = await handleComboChat({
    body: { model: "combo", stream: true, messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_body, modelStr) => {
      attempted.push(modelStr);
      return responders[modelStr]();
    },
    log,
    comboName: "combo-timeout-selfcheck",
    comboStrategy: "fallback",
    signal: opts.signal ?? null,
  });
  assert.equal(pendingTimers.size, 0, `rò rỉ timer sau combo [${models}]`);
  return { attempted, log, response };
}

function timeoutLogged(log) {
  return log._warn.some(([, m]) => /timed out/i.test(String(m)) && !/empty stream/i.test(String(m)));
}

// ---- Cases (mỗi case đặt tên theo break nó bắt) ----
const cases = [
  ["hang timeout trả 504/server_error/gateway_timeout, log timeout, cancel reader", async (ctx) => {
    const hooks = {};
    const { log, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(hangingStream(hooks)) }, ["p1/a"]);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: { message: TIMEOUT_MSG, type: TIMEOUT_TYPE, code: TIMEOUT_CODE },
    });
    assert.equal(hooks.cancelled, true);
    assert.equal(timeoutLogged(log), true);
  }],

  ["keepalive-only rồi stall trả 504 và message timeout", async (ctx) => {
    const hooks = {};
    const { log, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(stallAfter(": keepalive\n\n", hooks)) }, ["p1/a"]);
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.message, TIMEOUT_MSG);
    assert.equal(body.error.type, TIMEOUT_TYPE);
    assert.equal(body.error.code, TIMEOUT_CODE);
    assert.equal(hooks.cancelled, true);
    assert.equal(timeoutLogged(log), true);
  }],

  ["EOF rỗng giữ 503 và message cũ, không type/code", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(bytesStream([])) }, ["p1/a"]);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.message, EMPTY_MSG);
    assert.ok(!("type" in body.error) && !("code" in body.error));
  }],

  ["timeout rồi fallback thành công trả nội dung model sau", async (ctx) => {
    const { attempted, response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(hangingStream({})),
      "p2/b": () => sseResponse(bytesStream([enc.encode(CONTENT_FRAME)])),
    }, ["p1/a", "p2/b"]);
    assert.deepEqual(attempted, ["p1/a", "p2/b"]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello combo/);
  }],

  ["EOF rồi fallback thành công trả nội dung model sau", async (ctx) => {
    const { attempted, response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(bytesStream([])),
      "p2/b": () => sseResponse(bytesStream([enc.encode(CONTENT_FRAME)])),
    }, ["p1/a", "p2/b"]);
    assert.deepEqual(attempted, ["p1/a", "p2/b"]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello combo/);
  }],

  ["structured SSE error đơn lẻ giữ phân loại cũ", async (ctx) => {
    const frame = 'data: {"error":{"message":"upstream broken","type":"server_error"}}\n\n';
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(bytesStream([enc.encode(frame)])) }, ["p1/a"]);
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.message, "upstream broken");
    assert.equal(body.error.type, "server_error");
    assert.ok(!("code" in body.error));
  }],

  ["structured SSE error rồi fallback thành công", async (ctx) => {
    const frame = 'data: {"error":{"message":"upstream broken","type":"server_error"}}\n\n';
    const { attempted, response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(bytesStream([enc.encode(frame)])),
      "p2/b": () => sseResponse(bytesStream([enc.encode(CONTENT_FRAME)])),
    }, ["p1/a", "p2/b"]);
    assert.deepEqual(attempted, ["p1/a", "p2/b"]);
    assert.match(await response.text(), /hello combo/);
  }],

  ["429 rồi timeout không giữ type/code/status cũ", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => jsonErrorResponse(429, {
        message: "rate limit exceeded, slow down",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }),
      "p2/b": () => sseResponse(hangingStream({})),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: { message: TIMEOUT_MSG, type: TIMEOUT_TYPE, code: TIMEOUT_CODE },
    });
  }],

  ["timeout rồi EOF không giữ metadata timeout", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(hangingStream({})),
      "p2/b": () => sseResponse(bytesStream([])),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.message, EMPTY_MSG);
    assert.ok(!("type" in body.error) && !("code" in body.error));
  }],

  ["EOF rồi timeout trả 504 và metadata timeout", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(bytesStream([])),
      "p2/b": () => sseResponse(hangingStream({})),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: { message: TIMEOUT_MSG, type: TIMEOUT_TYPE, code: TIMEOUT_CODE },
    });
  }],

  ["abort trước peek không thử model nào, trả 499", async (ctx) => {
    const c = new AbortController();
    c.abort(new Error("stop now"));
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(bytesStream([enc.encode(CONTENT_FRAME)])) },
      ["p1/a"], { signal: c.signal });
    assert.deepEqual(attempted, []);
    assert.equal(response.status, 499);
    assert.match((await response.json()).error.message, /stop now/);
  }],

  ["abort trong peek không thử model sau, cancel reader", async (ctx) => {
    const hooks = {};
    const c = new AbortController();
    setTimeout(() => c.abort(new Error("user stop")), 10);
    const { attempted, response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(hangingStream(hooks)),
      "p2/b": () => sseResponse(bytesStream([enc.encode(CONTENT_FRAME)])),
    }, ["p1/a", "p2/b"], { signal: c.signal });
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response.status, 499);
    assert.equal(hooks.cancelled, true);
  }],

  ["replay nguyên bytes kể cả preamble không phải UTF-8", async (ctx) => {
    const preamble = new Uint8Array([0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a]);
    const frame = enc.encode('data: {"choices":[{"delta":{"content":"hello replay"}}]}\n\n');
    const done = enc.encode("data: [DONE]\n\n");
    const raw = new Uint8Array([...preamble, ...frame, ...done]);
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => sseResponse(bytesStream([preamble, frame, done])) }, ["p1/a"]);
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response.status, 200);
    const out = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(out, raw);
    assert.match(new TextDecoder().decode(out), /hello replay/);
  }],

  ["429 kèm retryAfter rồi timeout giữ type/code, giữ retry-after", async (ctx) => {
    const retryAfter = new Date(Date.now() + 30 * 1000).toISOString();
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => jsonErrorResponse(429, {
        message: "rate limit exceeded, slow down",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }, retryAfter),
      "p2/b": () => sseResponse(hangingStream({})),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.type, TIMEOUT_TYPE);
    assert.equal(body.error.code, TIMEOUT_CODE);
    assert.match(body.error.message, new RegExp(TIMEOUT_MSG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body.error.message, /reset after/);
    const retryAfterSec = Number(response.headers.get("retry-after"));
    assert.equal(Number.isFinite(retryAfterSec) && retryAfterSec >= 1, true);
  }],

  ["429 kèm retryAfter rồi EOF giữ 503, không bổ sung type/code timeout", async (ctx) => {
    const retryAfter = new Date(Date.now() + 30 * 1000).toISOString();
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => jsonErrorResponse(429, {
        message: "rate limit exceeded, slow down",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }, retryAfter),
      "p2/b": () => sseResponse(bytesStream([])),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.message.startsWith(EMPTY_MSG), true);
    assert.match(body.error.message, /reset after/);
    assert.ok(!("type" in body.error) && !("code" in body.error));
  }],

  ["non-SSE JSON không bị chạm: status/body/headers nguyên", async (ctx) => {
    const payload = JSON.stringify({ ok: true, data: [1, 2, 3] });
    const upstream = new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => upstream }, ["p1/a"]);
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), payload);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
  }],

  ["timeout rồi throw không giữ metadata timeout", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(hangingStream({})),
      "p2/b": () => { throw new Error("boom throw"); },
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.match(body.error.message, /boom throw/);
    assert.ok(!("type" in body.error) && !("code" in body.error), "throw sau timeout khong duoc mang type/code timeout");
  }],

  ["timeout rồi JSON500 không type/code không giữ metadata timeout", async (ctx) => {
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => sseResponse(hangingStream({})),
      "p2/b": () => jsonErrorResponse(500, { message: "boom json" }),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.message, "boom json");
    assert.ok(!("type" in body.error) && !("code" in body.error), "JSON500 sau timeout khong duoc mang type/code timeout");
  }],

  ["429 kèm retryAfter rồi upstream500 cùng timeout message không gán metadata timeout giả", async (ctx) => {
    const retryAfter = new Date(Date.now() + 30 * 1000).toISOString();
    const { response } = await runCombo(ctx.handleComboChat, {
      "p1/a": () => jsonErrorResponse(429, {
        message: "rate limit exceeded, slow down",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }, retryAfter),
      "p2/b": () => jsonErrorResponse(500, { message: TIMEOUT_MSG }),
    }, ["p1/a", "p2/b"]);
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.match(body.error.message, new RegExp(TIMEOUT_MSG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body.error.message, /reset after/);
    assert.ok(!("type" in body.error) && !("code" in body.error), "upstream500 trung message timeout khong duoc gan type/code timeout");
    const retryAfterSec = Number(response.headers.get("retry-after"));
    assert.equal(Number.isFinite(retryAfterSec) && retryAfterSec >= 1, true);
  }],

  ["non-SSE audio binary giữ identity và bodyUsed trước khi đọc", async (ctx) => {
    const raw = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x01]);
    const upstream = new Response(raw, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => upstream }, ["p1/a"]);
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response === upstream, true, "phai tra ve dung Response goc cho audio non-SSE");
    assert.equal(response.bodyUsed, false, "peek khong duoc consume body audio");
    assert.equal(upstream.bodyUsed, false, "upstream audio bodyUsed phai false truoc khi doc");
    const out = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(out, raw);
  }],

  ["non-SSE image binary giữ identity và bodyUsed trước khi đọc", async (ctx) => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const upstream = new Response(raw, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    const { attempted, response } = await runCombo(ctx.handleComboChat,
      { "p1/a": () => upstream }, ["p1/a"]);
    assert.deepEqual(attempted, ["p1/a"]);
    assert.equal(response === upstream, true, "phai tra ve dung Response goc cho image non-SSE");
    assert.equal(response.bodyUsed, false, "peek khong duoc consume body image");
    assert.equal(upstream.bodyUsed, false, "upstream image bodyUsed phai false truoc khi doc");
    const out = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(out, raw);
  }],
];

let namespace;
try {
  namespace = await loadCombo();
} catch (e) {
  console.error(`LOAD ERROR: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(2);
}

const ctx = { handleComboChat: namespace.handleComboChat };
assert.equal(typeof ctx.handleComboChat, "function", "handleComboChat phải là export function");

let pass = 0;
let fail = 0;
for (const [name, fn] of cases) {
  try {
    await fn(ctx);
    pass++;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`not ok - ${name}`);
    console.log(e && e.stack ? e.stack : String(e));
  }
}
console.log(`# pass=${pass} fail=${fail} total=${cases.length}`);
clearInterval(keepalive);
process.exitCode = fail ? 1 : 0;
