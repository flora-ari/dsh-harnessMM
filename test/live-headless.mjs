/**
 * End-to-end check on a real DeepSeek Harness agent loop.
 *
 * A scripted Messages endpoint stands in for the provider, so the run needs no
 * account; everything else is real — the harness CLI, the native shell executor,
 * the session log and the plugin.
 *
 * Scenario: the slow actor declares a two-step graph next to its root call. The
 * root receipt satisfies step A, whose receipt satisfies step B, so the loop
 * must run two substitutions without asking the model. The model is only
 * consulted again once the graph is exhausted, and then it reads the status
 * tool.
 *
 * Usage:
 *   node test/live-headless.mjs --dsh C:/path/to/dsh-or-bin.js [--tool pwsh]
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const target = flag('dsh', process.env.DSH_BIN || 'dsh');
const tool = flag('tool', process.env.HARNESSMM_LIVE_TOOL || 'pwsh');
const run = promisify(execFile);
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const plugin = resolve(here, '..', 'lib', 'index.js');

if (!target.endsWith('.js') && !target.endsWith('.cjs') && !target.endsWith('.mjs')) {
  console.log('No harness CLI given. Pass --dsh <dsh executable or bin.js>.');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'hmm-live-'));
const home = join(root, 'home');
const sessions = join(root, 'sessions');
const cwd = join(root, 'workspace');
const receipts = join(root, 'receipts.jsonl');
const marker = join(cwd, 'hmm-live.txt');
mkdirSync(cwd, { recursive: true });

const rootArgs = { description: 'Print the root marker', command: 'echo HMM-ROOT-MARK' };
const stepA = { description: 'Print step A', command: 'echo HMM-STEP-A' };
const stepB = { description: 'Print step B and record it', command: 'echo HMM-STEP-B; echo HMM-STEP-B >> hmm-live.txt' };
const plan = '<CHISEL_PLAN>' + JSON.stringify({
  candidates: [
    {
      candidate_id: 'A',
      predecessor_id: 'root',
      tool,
      arguments: stepA,
      guard: { exit_code: 0, stdout_equals: 'HMM-ROOT-MARK' },
      required_receipt_fields: ['exit_code', 'stdout'],
      expected_local_cost: { selector_upper_tokens: 0 },
      dependency_ids: [],
    },
    {
      candidate_id: 'B',
      predecessor_id: 'A',
      tool,
      arguments: stepB,
      guard: { exit_code: 0 },
      required_receipt_fields: ['exit_code'],
      expected_local_cost: { selector_upper_tokens: 0 },
      dependency_ids: ['A'],
    },
  ],
}) + '</CHISEL_PLAN>';

const block = (id, name, input) => ({ type: 'tool_use', id, name, input });
const responses = [
  [{ type: 'text', text: plan }, block('call_root', tool, rootArgs)],
  [block('call_status', 'harnessmm_status', {})],
  [{ type: 'text', text: 'The graph ran and the counters agree.' }],
];

let requests = 0;
let fixtureError;
const bodies = [];
const server = createServer(async (request, response) => {
  try {
    const data = [];
    for await (const chunk of request) data.push(chunk);
    const body = JSON.parse(Buffer.concat(data).toString());
    const index = requests++;
    bodies.push(body);
    assert.ok(responses[index], 'unexpected model request #' + index);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, value = {}) => response.write('event: ' + type + String.fromCharCode(10)
      + 'data: ' + JSON.stringify({ type, ...value }) + String.fromCharCode(10, 10));
    emit('message_start', { message: { id: 'msg_' + index, role: 'assistant', type: 'message', model: body.model, content: [], usage: { input_tokens: 1800, output_tokens: 0 } } });
    responses[index].forEach((item, position) => {
      if (item.type === 'text') {
        emit('content_block_start', { index: position, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index: position, delta: { type: 'text_delta', text: item.text } });
      } else {
        emit('content_block_start', { index: position, content_block: { ...item, input: {} } });
        emit('content_block_delta', { index: position, delta: { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } });
      }
      emit('content_block_stop', { index: position });
    });
    emit('message_delta', {
      delta: { stop_reason: responses[index].at(-1).type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 120 },
    });
    emit('message_stop');
    response.end();
  } catch (error) {
    fixtureError = error;
    response.writeHead(400);
    response.end('{}');
  }
});

const listen = () => new Promise(done => server.listen(0, '127.0.0.1', done));
await listen();
const baseURL = 'http://127.0.0.1:' + server.address().port;

const patch = join(root, 'patch.json');
writeFileSync(patch, JSON.stringify([
  { id: 'session-log-deepseek', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
  { id: 'agent-instructions', disabled: true },
  { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  { id: 'llm-deepseek', config: { baseURL } },
  { insert: [{ id: 'harnessmm', name: plugin, config: { policy: { enabled: true }, receiptsFile: receipts } }] },
], null, 2));

const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'hmm-live', DEEPSEEK_BASE_URL: baseURL };

const noise = text => String(text ?? '').replace(/\u0000/g, '');

try {
  const result = await run(process.execPath, [target, 'headless', '--patch', patch, '--json', 'Run the HarnessMM live check.'], {
    cwd, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  if (fixtureError) throw fixtureError;

  const events = result.stdout.split(String.fromCharCode(10))
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  // 1. Exactly three model requests: authoring, post-exhaustion, post-status.
  assert.equal(requests, 3, 'two substitutions must skip two model requests, got ' + requests);

  // 2. Both substituted calls ran through the native executor.
  const calls = events.filter(event => event.type === 'tool_call').map(event => event.tool + ' ' + String(event.callId));
  const results = events.filter(event => event.type === 'tool_result');
  assert.ok(results.some(event => String(event.callId).startsWith('chisel_')), 'a chisel call must run');
  const chisel = results.filter(event => String(event.callId).startsWith('chisel_'));
  assert.equal(chisel.length, 2, 'expected two substituted steps, ran ' + chisel.length + ' of ' + JSON.stringify(calls));
  assert.ok(chisel[0].result.includes('HMM-STEP-A'));
  assert.ok(chisel[1].result.includes('HMM-STEP-B'));

  // 3. The chain is ordered: A precedes B in the transcript.
  assert.ok(events.findIndex(event => String(event.callId).endsWith('_A')) < events.findIndex(event => String(event.callId).endsWith('_B')));

  // 4. The side effect the second substitution promised exists.
  const written = noise(readFileSync(marker, 'utf8'));
  assert.ok(written.includes('HMM-STEP-B'), 'the substituted command must have written its marker');

  // 5. Two certificates, each with a non-null bypassed callback and a receipt.
  const certificates = readFileSync(receipts, 'utf8').trim().split(String.fromCharCode(10))
    .filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'substitution');
  assert.equal(certificates.length, 2, 'expected two certificates');
  for (const certificate of certificates) {
    assert.equal(certificate.schema, 'harnessmm-dsh-certificate/v1');
    assert.ok(certificate.bypassed_slow_callback_id, 'bypassed_slow_callback_id must not be null');
    assert.match(certificate.bypassed_slow_callback_id, /:omitted:\d+$/);
    assert.ok(certificate.graph_hash);
    assert.ok(certificate.native_receipt.value.stdout.length > 0);
    assert.equal(certificate.valid_substitution, true);
  }
  assert.deepEqual(certificates.map(entry => entry.candidate_id), ['A', 'B']);

  // 6. The status tool answered from the plugin's own per-session state.
  const statusResult = results.find(event => event.callId === 'call_status');
  assert.ok(statusResult, 'the status tool must return a result');
  const status = JSON.parse(statusResult.result);
  assert.equal(status.enabled, true);
  assert.equal(status.substitutions_certified, 2);
  assert.equal(status.substitutions_issued, 2);
  assert.equal(status.banks_authored, 1);

  // 7. No request re-sent the authored plan as a fresh bank after exhaustion.
  assert.equal(bodies.length, 3);

  console.log('PASS  live harness run');
  console.log('  model requests      : ' + requests + ' (2 substituted steps skipped)');
  console.log('  substituted calls   : ' + chisel.map(event => event.callId).join(', '));
  console.log('  certificates        : ' + certificates.map(entry => entry.candidate_id + ' ' + entry.bypassed_slow_callback_id).join(' | '));
  console.log('  status              : ' + JSON.stringify(status));
  console.log('  artifacts           : ' + root);
} catch (error) {
  console.error('FAIL  live harness run');
  console.error('artifacts: ' + root);
  if (error.stdout) console.error(String(error.stdout).split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10)));
  if (error.stderr) console.error(String(error.stderr).split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));
  if (fixtureError) console.error('fixture: ' + fixtureError.message);
  throw error;
} finally {
  server.closeAllConnections();
  server.close();
}
