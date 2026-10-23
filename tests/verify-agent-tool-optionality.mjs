// Chạy nguyên source translator trong VM với import allowlist, không chạy Agent.
// Registry và image I/O được stub; các helpers/schema còn lại dùng source thật.
// Chạy: node --experimental-vm-modules tests/verify-agent-tool-optionality.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const allowed = new Set([
  'open-sse/translator/request/claude-to-responses.js',
  'open-sse/translator/request/openai-responses.js',
  'open-sse/translator/formats.js',
  'open-sse/translator/formats/responsesApi.js',
  'open-sse/translator/schema/index.js',
  'open-sse/translator/schema/roles.js',
  'open-sse/translator/schema/blocks.js',
  'open-sse/translator/schema/finishReasons.js',
  'open-sse/translator/schema/defaults.js',
  'open-sse/providers/familyProfiles.js',
]);
const registry = new Map();
const context = vm.createContext({});
const cache = new Map();
const stubs = new Map([
  [new URL('open-sse/translator/index.js', root).href,
    new vm.SyntheticModule(['register'], function () {
      this.setExport('register', (from, to, fn) => { if (fn) registry.set(`${from}:${to}`, fn); });
    }, { context })],
  [new URL('open-sse/translator/concerns/image.js', root).href,
    new vm.SyntheticModule(['encodeDataUri'], function () {
      this.setExport('encodeDataUri', (mime, bytes) => `data:${mime};base64,${bytes}`);
    }, { context })],
]);
async function load(url) {
  if (stubs.has(url.href)) return stubs.get(url.href);
  const rel = url.href.slice(root.href.length);
  assert.ok(url.href.startsWith(root.href) && allowed.has(rel), `Import ngoài allowlist: ${url.href}`);
  if (cache.has(url.href)) return cache.get(url.href);
  const mod = new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), {
    context, identifier: url.href,
    importModuleDynamically() { throw Error('Không cho dynamic import'); },
  });
  cache.set(url.href, mod);
  await mod.link((spec, parent) => load(new URL(spec, parent.identifier)));
  return mod;
}
const direct = await load(new URL('open-sse/translator/request/claude-to-responses.js', root));
await direct.evaluate();
const pivot = await load(new URL('open-sse/translator/request/openai-responses.js', root));
await pivot.evaluate();
const plain = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const schema = freeze({
  type: 'object',
  properties: {
    description: { type: 'string' }, prompt: { type: 'string' },
    isolation: { type: 'string', enum: ['worktree', 'remote'] },
    options: {
      type: 'object',
      properties: { model: { type: 'string' }, label: { type: 'string' } },
      required: ['label'],
    },
  },
  required: ['description', 'prompt'],
});
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.error(`FAIL ${name}: ${e.message}`); }
}
function convert(model, extra = {}, inputSchema = schema) {
  const body = freeze({
    tools: [{ name: 'Agent', input_schema: inputSchema, ...extra }],
    messages: [{ role: 'user', content: 'Fixture, không chạy agent.' }],
  });
  const family = model.startsWith('muse-') ? 'muse-spark' : 'gpt-family';
  return registry.get(`claude:${family}:openai-responses`)(model, body, false, null);
}
for (const model of ['muse-spark-1.3', 'gpt-4o']) {
  check(`${model}: bỏ strict giữ isolation tùy chọn`, () => {
    const out = convert(model);
    assert.equal(out.tools[0].strict, false);
    assert.deepEqual(plain(out.tools[0].parameters), schema);
    assert.equal(out.tools[0].parameters.required.includes('isolation'), false);
    const call = { description: 'Kiểm', prompt: 'Fixture' };
    assert.ok(out.tools[0].parameters.required.every(key => Object.hasOwn(call, key)));
  });
  for (const strict of [true, false]) check(`${model}: giữ strict ${strict}`, () => {
    assert.equal(convert(model, { strict }).tools[0].strict, strict);
  });
  for (const strict of [null, 'true']) check(`${model}: strict không boolean mặc định false`, () => {
    assert.equal(convert(model, { strict }).tools[0].strict, false);
  });
  check(`${model}: schema thiếu properties được bổ sung`, () => {
    const out = convert(model, {}, { type: 'object' });
    assert.deepEqual(plain(out.tools[0].parameters), { type: 'object', properties: {} });
    assert.equal(out.tools[0].strict, false);
  });
  check(`${model}: giữ nested required và source bất biến`, () => {
    assert.deepEqual(plain(convert(model).tools[0].parameters.properties.options.required), ['label']);
    assert.deepEqual(schema.required, ['description', 'prompt']);
    assert.deepEqual(schema.properties.isolation.enum, ['worktree', 'remote']);
  });
}
check('Direct và Chat-to-Responses thống nhất strict mặc định', () => {
  const out = pivot.namespace.openaiToOpenAIResponsesRequest('gpt-4o', {
    messages: [{ role: 'user', content: 'Fixture' }],
    tools: [{ type: 'function', function: { name: 'Agent', parameters: schema } }],
  }, false, null);
  assert.equal(out.tools[0].strict, false);
  assert.equal(convert('gpt-4o').tools[0].strict, out.tools[0].strict);
});
console.log(JSON.stringify({ pass, fail, total: pass + fail }));
process.exitCode = fail ? 1 : 0;
