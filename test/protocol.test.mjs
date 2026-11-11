import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BankContractError,
  CERTIFICATE_SCHEMA,
  LABELS,
  POLICY_VERSION,
  PLAN_CLOSE,
  PLAN_OPEN,
  decide,
  deterministicAdmission,
  executedLabels,
  hashJson,
  localGuard,
  makeCertificate,
  nativeCallId,
  parseBank,
  projectTurn,
  publicReceipt,
  sameLiteral,
  violateDispatch,
} from '../lib/protocol.mjs';

const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const TOOLS = [{ name: 'pwsh' }, { name: 'bash' }, { name: 'read' }];
const POLICY = {
  enabled: true,
  version: POLICY_VERSION,
  maximum_candidates: 16,
  maximum_fast_steps: 8,
  maximum_public_bytes: 65536,
  admission_threshold_tokens: 1024,
};

/** Guard field to the receipt field it reads, for building valid fixtures. */
const GUARD_READS = {
  ok: 'ok',
  exit_code: 'exit_code',
  stdout_contains: 'stdout',
  stdout_equals: 'stdout',
  stderr_empty: 'stderr',
  json_equals: 'stdout',
};

/** One authored candidate, with the exact closed key set. */
function candidate(label, predecessor, command, guard = { exit_code: 0 }, extra = {}) {
  return {
    candidate_id: label,
    predecessor_id: predecessor,
    tool: 'pwsh',
    arguments: { description: 'step ' + label, command },
    guard,
    required_receipt_fields: Object.keys(guard).map(key => GUARD_READS[key]),
    expected_local_cost: { selector_upper_tokens: 8192 },
    dependency_ids: [],
    ...extra,
  };
}

function plan(...candidates) {
  return PLAN_OPEN + JSON.stringify({ candidates }) + PLAN_CLOSE;
}

function assistant(text, call) {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...(call ? [{ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : []),
    ],
  };
}

function toolMessage(id, text, isError = false) {
  return { role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] };
}

/* ----------------------------------------------------------------- receipt */

test('publicReceipt canonicalises CRLF and the trailing newline', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'hello' + CRLF });
  assert.equal(receipt.status, 'PARSED');
  assert.equal(receipt.value.exit_code, 0);
  assert.equal(receipt.value.stdout, 'hello');
});

test('publicReceipt reads a nonzero exit trailer and drops it from stdout', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'boom' + NL + '[exit code: 3]' });
  assert.equal(receipt.value.exit_code, 3);
  assert.equal(receipt.value.stdout, 'boom');
});

test('publicReceipt splits the stderr section', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'out' + NL + '[stderr]' + NL + 'warn' + NL });
  assert.equal(receipt.value.stdout, 'out');
  assert.equal(receipt.value.stderr, 'warn');
});

test('publicReceipt keeps a native error unreadable', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'denied', isError: true });
  assert.equal(receipt.is_error, true);
  assert.equal(receipt.value.exit_code, null);
  const verdict = localGuard(candidate('A', 'root', 'x'), receipt);
  assert.equal(verdict.known, true);
  assert.equal(verdict.eligible, false);
});

test('publicReceipt refuses a background handle', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'job 3', canonical: { kind: 'background' } });
  assert.equal(receipt.status, 'UNKNOWN');
  assert.equal(localGuard(candidate('A', 'root', 'x'), receipt).known, false);
});

test('publicReceipt prefers the canonical exit code', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'x', canonical: { kind: 'foreground', exitCode: 7 } });
  assert.equal(receipt.value.exit_code, 7);
});

/* ------------------------------------------------------------------- guard */

test('localGuard admits a matching exit code', () => {
  const verdict = localGuard(candidate('A', 'root', 'npm test'), publicReceipt({ name: 'pwsh', text: 'ok' }));
  assert.deepEqual([verdict.known, verdict.eligible], [true, true]);
});

test('localGuard refuses a different exit code with known evidence', () => {
  const verdict = localGuard(candidate('A', 'root', 'npm test'), publicReceipt({ name: 'pwsh', text: 'x' + NL + '[exit code: 2]' }));
  assert.equal(verdict.known, true);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, 'guard_false');
});

test('localGuard treats an absent exit status as unknown', () => {
  const receipt = publicReceipt({ name: 'read', text: 'file body' });
  assert.equal(receipt.value.exit_code, null);
  const verdict = localGuard(candidate('A', 'root', 'x'), receipt);
  assert.equal(verdict.known, false);
  assert.equal(verdict.reason, 'exit_code_unknown');
});

test('localGuard matches stdout literally after canonicalisation', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: 'HMM-ROOT' + CRLF });
  const node = candidate('A', 'root', 'x', { exit_code: 0, stdout_equals: 'HMM-ROOT' });
  assert.equal(localGuard(node, receipt).eligible, true);
  assert.equal(localGuard({ ...node, guard: { stdout_equals: 'hmm-root' } }, receipt).eligible, false);
});

test('localGuard requires every guard field in required_receipt_fields', () => {
  const node = { ...candidate('A', 'root', 'x'), guard: { exit_code: 0, stdout_contains: 'ok' }, required_receipt_fields: ['exit_code'] };
  const verdict = localGuard(node, publicReceipt({ name: 'pwsh', text: 'ok' }));
  assert.equal(verdict.known, false);
  assert.equal(verdict.reason, 'required_field_missing');
});

test('localGuard refuses an unsupported guard field', () => {
  const node = { ...candidate('A', 'root', 'x'), guard: { stdout_matches: 'x' }, required_receipt_fields: ['stdout'] };
  assert.equal(localGuard(node, publicReceipt({ name: 'pwsh', text: 'x' })).reason, 'unsupported_guard_field');
});

test('localGuard resolves json_equals against parsed stdout', () => {
  const receipt = publicReceipt({ name: 'pwsh', text: '{"seq":4,"ok":true}' });
  const good = candidate('A', 'root', 'x', { json_equals: { path: ['seq'], value: 4 } });
  assert.equal(localGuard(good, receipt).eligible, true);
  const bad = candidate('A', 'root', 'x', { json_equals: { path: ['seq'], value: 5 } });
  assert.equal(localGuard(bad, receipt).eligible, false);
  const poison = candidate('A', 'root', 'x', { json_equals: { path: ['__proto__'], value: 1 } });
  assert.equal(localGuard(poison, receipt).known, false);
});

test('localGuard reads stderr_empty', () => {
  const clean = publicReceipt({ name: 'pwsh', text: 'out' });
  const dirty = publicReceipt({ name: 'pwsh', text: 'out' + NL + '[stderr]' + NL + 'warn' });
  const node = candidate('A', 'root', 'x', { stderr_empty: true });
  assert.equal(localGuard(node, clean).eligible, true);
  assert.equal(localGuard(node, dirty).eligible, false);
});

/* --------------------------------------------------------------- admission */

test('admission commits one survivor deterministically below the threshold', () => {
  const result = deterministicAdmission({
    candidates: [candidate('A', 'root', 'x')],
    receipt: publicReceipt({ name: 'pwsh', text: 'ok' }),
    done: new Set(['root']),
    slowTokens: 10,
    deterministic: true,
  });
  assert.equal(result.single, true);
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].reason, 'admitted_deterministic');
});

test('admission refuses a selector step that does not pay for itself', () => {
  const result = deterministicAdmission({
    candidates: [candidate('A', 'root', 'x'), candidate('B', 'root', 'y')],
    receipt: publicReceipt({ name: 'pwsh', text: 'ok' }),
    done: new Set(['root']),
    slowTokens: 600,
    deterministic: false,
  });
  assert.equal(result.single, false);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.rejected[0].reason, 'net_saving_threshold');
});

test('admission admits a selector step above the threshold', () => {
  const result = deterministicAdmission({
    candidates: [candidate('A', 'root', 'x'), candidate('B', 'root', 'y')],
    receipt: publicReceipt({ name: 'pwsh', text: 'ok' }),
    done: new Set(['root']),
    slowTokens: 4000,
    deterministic: false,
  });
  assert.equal(result.eligible.length, 2);
});

test('admission refuses a candidate whose dependency has not run', () => {
  const node = candidate('B', 'A', 'y', { exit_code: 0 }, { dependency_ids: ['A'] });
  const result = deterministicAdmission({
    candidates: [node],
    receipt: publicReceipt({ name: 'pwsh', text: 'ok' }),
    done: new Set(['root']),
    slowTokens: 4000,
    deterministic: true,
  });
  assert.equal(result.rejected[0].reason, 'dependency_missing');
});

/* -------------------------------------------------------------- bank parse */

test('parseBank accepts one closed bank', () => {
  const bank = parseBank(assistant(plan(candidate('A', 'root', 'npm test')), { id: 'call_root', name: 'pwsh', args: { description: 'r', command: 'echo root' } }), TOOLS);
  assert.ok(bank);
  assert.equal(bank.candidates.length, 1);
  assert.equal(bank.root.id, 'call_root');
  assert.equal(bank.sha256.length, 64);
});

test('parseBank ignores a declaration inside a code fence', () => {
  const fence = String.fromCharCode(96, 96, 96);
  const text = fence + NL + plan(candidate('A', 'root', 'x')) + NL + fence;
  const bank = parseBank(assistant(text, { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS);
  assert.equal(bank, null);
});

test('parseBank reads the same plan twice as one declaration', () => {
  const body = plan(candidate('A', 'root', 'x'));
  const message = assistant(body, { id: 'c', name: 'pwsh', args: { command: 'echo r' } });
  message.content.unshift({ type: 'reasoning', text: body });
  const bank = parseBank(message, TOOLS);
  assert.equal(bank.candidates.length, 1);
});

test('parseBank refuses two distinct declarations', () => {
  const text = plan(candidate('A', 'root', 'x')) + NL + plan(candidate('B', 'root', 'y'));
  assert.throws(() => parseBank(assistant(text, { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS), BankContractError);
});

test('parseBank refuses a bank without exactly one root call', () => {
  assert.throws(() => parseBank(assistant(plan(candidate('A', 'root', 'x'))), TOOLS), BankContractError);
});

test('parseBank refuses a candidate with an extra key', () => {
  const node = { ...candidate('A', 'root', 'x'), note: 'extra' };
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS), BankContractError);
});

test('parseBank refuses an unresolved placeholder argument', () => {
  const node = candidate('A', 'root', 'x');
  node.arguments = { description: 'd', command: 'echo ' + String.fromCharCode(36) + '{RESULT}' };
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS), BankContractError);
});

test('parseBank refuses a candidate that repeats the root action', () => {
  const rootArgs = { description: 'r', command: 'echo root' };
  const node = candidate('A', 'root', 'echo root');
  node.arguments = rootArgs;
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: rootArgs }), TOOLS), BankContractError);
});

test('parseBank refuses a tool outside the visible catalog', () => {
  const node = candidate('A', 'root', 'x');
  node.tool = 'telepathy';
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS), BankContractError);
});

test('parseBank refuses a dependency declared later', () => {
  const node = candidate('A', 'root', 'x', { exit_code: 0 }, { dependency_ids: ['B'] });
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS), BankContractError);
});

test('parseBank refuses a label outside the configured range', () => {
  const node = candidate('Q', 'root', 'x');
  assert.throws(() => parseBank(assistant(plan(node), { id: 'c', name: 'pwsh', args: { command: 'echo r' } }), TOOLS, { maxCandidates: 4 }), BankContractError);
});

/* --------------------------------------------------------------- projection */

function chain() {
  const nodeA = candidate('A', 'root', 'echo sub-a');
  const nodeB = candidate('B', 'A', 'echo sub-b');
  const authored = assistant(plan(nodeA, nodeB), { id: 'call_root', name: 'pwsh', args: { description: 'r', command: 'echo root' } });
  const bank = parseBank(authored, TOOLS);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    authored,
    toolMessage('call_root', 'root' + CRLF),
  ];
  return { nodeA, nodeB, bank, messages, authored };
}

test('projectTurn finds the position after the root receipt', () => {
  const { messages } = chain();
  const projected = projectTurn(messages, TOOLS, POLICY);
  assert.ok(projected);
  assert.equal(projected.position, 'root');
  assert.equal(projected.steps, 0);
  assert.deepEqual(projected.objective, ['go']);
});

test('projectTurn follows one issued substitution', () => {
  const { messages, bank, nodeA } = chain();
  const callId = nativeCallId(bank.sha256, 'A');
  messages.push(assistant('', { id: callId, name: 'pwsh', args: nodeA.arguments }));
  messages.push(toolMessage(callId, 'sub-a' + CRLF));
  const projected = projectTurn(messages, TOOLS, POLICY);
  assert.ok(projected);
  assert.equal(projected.position, 'A');
  assert.equal(projected.steps, 1);
  assert.equal(projected.candidates.length, 1);
  assert.equal(projected.candidates[0].candidate_id, 'B');
});

test('projectTurn waits while the root receipt is missing', () => {
  const { messages } = chain();
  assert.equal(projectTurn(messages.slice(0, 2), TOOLS, POLICY), null);
});

test('projectTurn refuses a chain whose arguments were rewritten', () => {
  const { messages, bank } = chain();
  const callId = nativeCallId(bank.sha256, 'A');
  messages.push(assistant('', { id: callId, name: 'pwsh', args: { description: 'x', command: 'echo mutated' } }));
  messages.push(toolMessage(callId, 'sub-a'));
  assert.equal(projectTurn(messages, TOOLS, POLICY), null);
});

test('projectTurn reports no bank for a plain transcript', () => {
  assert.equal(projectTurn([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], TOOLS, POLICY), null);
});

/* ------------------------------------------------------------------ decide */

test('decide commits one surviving candidate', () => {
  const { messages } = chain();
  const projected = projectTurn(messages, TOOLS, POLICY);
  const decision = decide({ projected, receipt: publicReceipt({ name: 'pwsh', text: 'root' + CRLF }), slowTokens: 10, deterministic: true, policy: POLICY });
  assert.equal(decision.kind, 'commit');
  assert.equal(decision.candidate.candidate_id, 'A');
  assert.equal(decision.selector, 'deterministic');
});

test('decide asks the selector when several candidates survive', () => {
  const nodeA = candidate('A', 'root', 'echo a');
  const nodeB = candidate('B', 'root', 'echo b');
  const authored = assistant(plan(nodeA, nodeB), { id: 'call_root', name: 'pwsh', args: { description: 'r', command: 'echo root' } });
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    authored,
    toolMessage('call_root', 'root'),
  ];
  const projected = projectTurn(messages, TOOLS, POLICY);
  const decision = decide({ projected, receipt: publicReceipt({ name: 'pwsh', text: 'root' }), slowTokens: 8000, deterministic: false, policy: POLICY });
  assert.equal(decision.kind, 'select');
  assert.equal(decision.admission.eligible.length, 2);
  assert.equal(decision.payload.candidates.length, 2);
});

test('decide hands control back when no guard holds', () => {
  const { messages } = chain();
  const projected = projectTurn(messages, TOOLS, POLICY);
  const decision = decide({ projected, receipt: publicReceipt({ name: 'pwsh', text: 'nope' + NL + '[exit code: 1]' }), slowTokens: 8000, deterministic: true, policy: POLICY });
  assert.equal(decision.kind, 'slow');
  assert.equal(decision.reason, 'no_eligible_candidate');
  assert.equal(decision.admission.rejected[0].reason, 'guard_false');
});

/* ---------------------------------------------------------------- dispatch */

test('violateDispatch accepts the authored literal call', () => {
  const { nodeA, bank } = chain();
  const turn = { steps: 0, bank: { sha256: bank.sha256 }, candidates: [nodeA] };
  const call = { id: nativeCallId(bank.sha256, 'A'), name: 'pwsh', arguments: JSON.stringify({ command: 'echo sub-a', description: 'step A' }) };
  assert.equal(violateDispatch({ turn, call, policy: POLICY }), null);
});

test('violateDispatch refuses a mutated argument', () => {
  const { nodeA, bank } = chain();
  const turn = { steps: 0, bank: { sha256: bank.sha256 }, candidates: [nodeA] };
  const call = { id: nativeCallId(bank.sha256, 'A'), name: 'pwsh', arguments: JSON.stringify({ description: 'step A', command: 'rm -rf /' }) };
  assert.match(violateDispatch({ turn, call, policy: POLICY }).violation, /differ/);
});

test('violateDispatch refuses an unknown call id', () => {
  const { nodeA, bank } = chain();
  const turn = { steps: 0, bank: { sha256: bank.sha256 }, candidates: [nodeA] };
  const call = { id: 'chisel_deadbeefdeadbeefdeadbeef_A', name: 'pwsh', arguments: JSON.stringify(nodeA.arguments) };
  assert.match(violateDispatch({ turn, call, policy: POLICY }).violation, /not a live/);
});

test('violateDispatch refuses past the step budget', () => {
  const { nodeA, bank } = chain();
  const turn = { steps: 8, bank: { sha256: bank.sha256 }, candidates: [nodeA] };
  const call = { id: nativeCallId(bank.sha256, 'A'), name: 'pwsh', arguments: JSON.stringify(nodeA.arguments) };
  assert.match(violateDispatch({ turn, call, policy: POLICY }).violation, /maximum_fast_steps/);
});

/* ------------------------------------------------------------- certificate */

test('certificate carries the paper fields and a non-null bypassed callback', () => {
  const certificate = makeCertificate({
    turnId: 'session-1:turn-1',
    decisionId: 'decision-1',
    bankSha: 'a'.repeat(64),
    candidateId: 'A',
    predecessorId: 'root',
    predecessorReceiptHash: 'b'.repeat(64),
    bypassedCallbackId: 'session-1:request-1:omitted:0',
    tool: 'pwsh',
    argumentsText: '{"command":"echo a"}',
    receiptHash: 'c'.repeat(64),
    selector: 'deterministic',
    probability: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    slowTokens: 1400,
  });
  assert.equal(certificate.schema, CERTIFICATE_SCHEMA);
  assert.equal(certificate.graph_hash, 'a'.repeat(64));
  assert.equal(certificate.bypassed_slow_callback_id, 'session-1:request-1:omitted:0');
  assert.equal(certificate.amount_substituted_slow_callbacks, 1);
  assert.equal(certificate.valid_substitution, true);
  for (const key of ['graph_hash', 'decision_id', 'predecessor_receipt_hash', 'exact_arguments', 'native_receipt_hash', 'bypassed_slow_callback_id']) {
    assert.ok(certificate[key] !== undefined && certificate[key] !== null, key);
  }
});

/* ------------------------------------------------------------------ basics */

test('literal comparison ignores key order only', () => {
  assert.equal(sameLiteral({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameLiteral({ a: 1 }, { a: '1' }), false);
  assert.equal(hashJson({ a: 1 }), hashJson({ a: 1 }));
});

test('executedLabels walks the authored predecessor chain', () => {
  const bank = { candidates: [candidate('A', 'root', 'x'), candidate('B', 'A', 'y'), candidate('C', 'root', 'z')] };
  assert.deepEqual([...executedLabels({ position: 'B', bank })].sort(), ['A', 'B', 'root']);
  assert.deepEqual([...executedLabels({ position: 'root', bank })].sort(), ['root']);
});

test('LABELS exposes sixteen single-letter ids', () => {
  assert.equal(LABELS.length, 16);
  assert.equal(LABELS[15], 'P');
});
