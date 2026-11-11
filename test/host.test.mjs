import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { PLAN_CLOSE, PLAN_OPEN, nativeCallId } from '../lib/protocol.mjs';

const NL = String.fromCharCode(10);
const CATALOG = [{ name: 'pwsh' }, { name: 'bash' }, { name: 'read' }];

const GUARD_READS = {
  ok: 'ok',
  exit_code: 'exit_code',
  stdout_contains: 'stdout',
  stdout_equals: 'stdout',
  stderr_empty: 'stderr',
  json_equals: 'stdout',
};

function candidate(label, predecessor, command, guard = { exit_code: 0 }) {
  return {
    candidate_id: label,
    predecessor_id: predecessor,
    tool: 'pwsh',
    arguments: { description: 'step ' + label, command },
    guard,
    required_receipt_fields: Object.keys(guard).map(key => GUARD_READS[key]),
    expected_local_cost: { selector_upper_tokens: 8192 },
    dependency_ids: [],
  };
}

const plan = (...candidates) => PLAN_OPEN + JSON.stringify({ candidates }) + PLAN_CLOSE;

/** A fake Cordis context: only the seams this plugin touches. */
function fakeContext(selectorText = 'A') {
  const registered = { tools: [], sections: [], handlers: new Map() };
  const llm = {
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: selectorText } };
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 1, totalTokens: 901 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } };
    },
  };
  const ctx = {
    tools: {
      register: (definition) => registered.tools.push(definition),
      schemas: () => CATALOG,
    },
    systemPrompt: {
      section: (definition) => registered.sections.push(definition),
    },
    on: (event, handler) => registered.handlers.set(event, handler),
    get: (name) => (name === 'llm' ? llm : undefined),
  };
  return { ctx, registered, llm };
}

function authoringStream(text, call, totalTokens = 1400) {
  return (async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.args) };
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) } };
    yield { type: 'usage', usage: { inputTokens: totalTokens - 100, outputTokens: 100, totalTokens } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  })();
}

async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hmm-host-'));
  const receiptsFile = join(root, 'receipts.jsonl');
  const { ctx, registered } = fakeContext(overrides.selectorText ?? 'A');
  const config = {
    policy: { enabled: true, maximum_candidates: 16, maximum_fast_steps: 8, maximum_public_bytes: 65536, admission_threshold_tokens: 1024 },
    selector: { enabled: true, provider: '', model: '', maxTokens: 1024, timeoutMs: 20000 },
    shellTools: [],
    planSection: true,
    receiptsFile,
  };
  apply(ctx, config);
  const read = () => readFileSync(receiptsFile, 'utf8').trim().split(NL).filter(Boolean).map(line => JSON.parse(line));
  return { ctx, registered, receiptsFile, read, config };
}

const assistantMessage = (text, call) => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) },
  ],
});

const rootCall = { id: 'call_root', name: 'pwsh', args: { description: 'root', command: 'echo ROOT-MARK' } };
const toolResult = (id, text) => ({ role: 'tool', toolCallId: id, isError: false, content: [{ type: 'text', text }] });

test('the plugin registers its status tool and its plan section', () => {
  const { registered } = setup();
  assert.equal(registered.tools.length, 1);
  assert.equal(registered.tools[0].name, 'harnessmm_status');
  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].name, 'harnessmm:plan');
  const text = registered.sections[0].text();
  assert.ok(text.includes(PLAN_OPEN));
  assert.ok(text.includes('pwsh'));
});

test('the plan section disappears when the policy is disabled', () => {
  const { registered, config } = setup();
  config.policy.enabled = false;
  assert.equal(registered.sections[0].text(), '');
});

test('a slow turn authors a bank that is recorded', async () => {
  const { registered, read } = setup();
  const stream = registered.handlers.get('llm/stream');
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'run the tests' }] }];
  const chunks = await drain(stream(
    { sessionId: 'session-1', messages, tools: CATALOG, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    () => authoringStream(plan(candidate('A', 'root', 'echo SUB')), rootCall),
  ));
  assert.ok(chunks.length > 0);
  const entries = read();
  const bank = entries.find(entry => entry.type === 'bank');
  assert.ok(bank, 'a bank receipt must be written');
  assert.equal(bank.candidates, 1);
});

test('the boundary substitutes a candidate whose guard holds', async () => {
  const { registered, read } = setup();
  const stream = registered.handlers.get('llm/stream');
  const authored = assistantMessage(plan(candidate('A', 'root', 'echo SUB')), rootCall);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    authored,
    toolResult('call_root', 'ROOT-MARK' + NL),
  ];
  const produced = await drain(stream(
    { sessionId: 'session-1', messages, tools: CATALOG, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    () => { throw new Error('the stock model must not be called for a substitution'); },
  ));
  const call = produced.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.ok(call, 'a tool call must be emitted');
  assert.ok(call.block.id.startsWith('chisel_'));
  assert.equal(call.block.name, 'pwsh');
  assert.deepEqual(JSON.parse(call.block.arguments), { description: 'step A', command: 'echo SUB' });
  assert.equal(produced.at(-1).type, 'finish');
  assert.deepEqual(produced.at(-1).reason, { kind: 'tool-calls' });
  const decision = read().find(entry => entry.type === 'decision');
  assert.equal(decision.kind, 'commit');
  assert.deepEqual(decision.eligible, ['A']);
});

test('the certificate binds the substituted call and a non-null bypassed callback', async () => {
  const { registered, read } = setup();
  const stream = registered.handlers.get('llm/stream');
  const execute = registered.handlers.get('tools/execute');
  const result = registered.handlers.get('tools/result');
  const authored = assistantMessage(plan(candidate('A', 'root', 'echo SUB')), rootCall);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    authored,
    toolResult('call_root', 'ROOT-MARK' + NL),
  ];
  await drain(stream(
    { sessionId: 'session-1', messages, tools: CATALOG, provider: 'p', model: 'm' },
    () => { throw new Error('no stock call'); },
  ));
  const receipts = read();
  const issued = receipts.find(entry => entry.type === 'substitution-issued');
  assert.ok(issued);
  const call = { callId: issued.call_id, name: 'pwsh', arguments: JSON.stringify({ description: 'step A', command: 'echo SUB' }) };
  let dispatched = false;
  await execute({ agent: { id: 'session-1' }, ...call }, async () => { dispatched = true; });
  assert.equal(dispatched, true);
  result(
    { agent: { id: 'session-1' }, ...call },
    { isError: false, result: { value: { kind: 'foreground', exitCode: 0 }, content: [{ type: 'text', text: 'SUB' + NL }] } },
  );
  const certificate = read().find(entry => entry.type === 'substitution');
  assert.ok(certificate, 'a certificate must be written');
  assert.equal(certificate.schema, 'harnessmm-dsh-certificate/v1');
  assert.equal(certificate.candidate_id, 'A');
  assert.equal(certificate.exact_native_tool, 'pwsh');
  assert.ok(certificate.bypassed_slow_callback_id, 'the bypassed callback id must not be null');
  assert.match(certificate.bypassed_slow_callback_id, /:omitted:\d+$/);
  assert.equal(certificate.amount_substituted_slow_callbacks, 1);
  assert.equal(certificate.native_receipt.value.stdout, 'SUB');
});

test('a mutated substituted call is rejected before the executor', async () => {
  const { registered } = setup();
  const stream = registered.handlers.get('llm/stream');
  const execute = registered.handlers.get('tools/execute');
  const authored = assistantMessage(plan(candidate('A', 'root', 'echo SUB')), rootCall);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    authored,
    toolResult('call_root', 'ROOT-MARK'),
  ];
  await drain(stream({ sessionId: 'session-1', messages, tools: CATALOG, provider: 'p', model: 'm' }, () => { throw new Error('x'); }));
  const call = { callId: nativeCallId('f'.repeat(64), 'A'), name: 'pwsh', arguments: JSON.stringify({ description: 'step A', command: 'rm -rf /' }) };
  await assert.rejects(
    () => execute({ agent: { id: 'session-1' }, ...call }, async () => {}),
    /HarnessMM rejected a substituted call/,
  );
});

test('a false guard hands the turn back to the model', async () => {
  const { registered, read } = setup();
  const stream = registered.handlers.get('llm/stream');
  const guarded = candidate('A', 'root', 'echo SUB', { exit_code: 0, stdout_equals: 'ROOT-MARK' });
  const authored = assistantMessage(plan(guarded), rootCall);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    authored,
    { role: 'tool', toolCallId: 'call_root', isError: false, content: [{ type: 'text', text: 'SOMETHING-ELSE' }] },
  ];
  let stock = false;
  await drain(stream(
    { sessionId: 'session-1', messages, tools: CATALOG, provider: 'p', model: 'm' },
    () => { stock = true; return authoringStream('I will continue.', { id: 'call_next', name: 'pwsh', args: { description: 'd', command: 'echo next' } }); },
  ));
  assert.equal(stock, true, 'the stock stream must run when no guard holds');
  const decision = read().find(entry => entry.type === 'decision');
  assert.equal(decision.kind, 'slow');
  assert.equal(decision.rejected[0].reason, 'guard_false');
});

test('two survivors go through the selector', async () => {
  const { registered, read } = setup({ selectorText: 'B' });
  const stream = registered.handlers.get('llm/stream');
  const authored = assistantMessage(plan(candidate('A', 'root', 'echo A'), candidate('B', 'root', 'echo B')), rootCall);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    authored,
    toolResult('call_root', 'ROOT-MARK'),
  ];
  // The slow request runs first, exactly as the loop does: it carries the slow
  // turn's own usage, which is what a selector-assisted step has to beat.
  await drain(stream(
    { sessionId: 'session-1', messages: messages.slice(0, 1), tools: CATALOG, provider: 'p', model: 'm' },
    () => authoringStream(plan(candidate('A', 'root', 'echo A'), candidate('B', 'root', 'echo B')), rootCall, 4000),
  ));
  const produced = await drain(stream(
    { sessionId: 'session-1', messages, tools: CATALOG, provider: 'p', model: 'm' },
    () => { throw new Error('the stock model must not run'); },
  ));
  const call = produced.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.ok(call);
  const decision = read().find(entry => entry.type === 'decision');
  assert.equal(decision.kind, 'select');
  const issued = read().find(entry => entry.type === 'substitution-issued');
  assert.equal(issued.selector, 'fast-selector');
  assert.equal(issued.candidate_id, 'B');
});

test('the status tool reports this session only', async () => {
  const { registered } = setup();
  const status = registered.tools[0];
  const idle = await status.execute({}, { agent: { id: 'fresh-session' } });
  assert.equal(idle.enabled, true);
  assert.equal(idle.gate, 'idle');
  assert.equal(idle.substitutions_certified, 0);
  assert.equal(typeof idle.banks_authored, 'number');
});
