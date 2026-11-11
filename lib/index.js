/**
 * HarnessMM for DeepSeek Harness — guarded decision reuse at the model-to-tool
 * boundary.
 *
 * The paper's controller lives between the model and the tool surface: a slow
 * actor writes a frozen action bank once, later steps read only public receipts
 * decoded from the native tool output, and a one-character selector (or a
 * deterministic commit) picks an already-decided step. This plugin rebuilds
 * that boundary on top of the stock harness agent loop:
 *
 *   systemPrompt.section  -> the CHISEL_PLAN authoring dialect
 *   llm/stream            -> replace a settled reasoning request with a
 *                            certified native tool call
 *   tools/execute         -> accept that call only on exact literal equality
 *   tools/result          -> decode the real result and settle a certificate
 *
 * Nothing here replaces the native executor, the scorer or provider
 * accounting: a substituted action runs through the ordinary tool pipeline, so
 * the loop logs its result, renders its card and bills its usage itself.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BankContractError,
  LABELS,
  POLICY_VERSION,
  SHELL_TOOLS,
  SELECTOR_SYSTEM,
  decide,
  hash,
  hashJson,
  localGuard,
  makeCertificate,
  nativeCallId,
  parseBank,
  projectTurn,
  publicReceipt,
  violateDispatch,
} from './protocol.mjs';
import { planText } from './plan.mjs';

export { Config } from './config.mjs';
export { planText } from './plan.mjs';

export const name = 'harnessmm';
export const inject = ['systemPrompt', 'tools'];

const SECTION_NAME = 'harnessmm:plan';
const STORE_LIMIT = 64;

/** Counter keys the status tool reports. */
const COUNTERS = [
  'banks_authored', 'decisions_commit', 'decisions_select', 'decisions_slow',
  'substitutions_issued', 'substitutions_certified', 'selector_abstentions',
  'dispatch_rejections', 'boundary_errors',
];
const emptyCounters = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));

function counterOf(entry) {
  if (entry.type === 'bank') return 'banks_authored';
  if (entry.type === 'decision') {
    return entry.kind === 'commit' ? 'decisions_commit'
      : entry.kind === 'select' ? 'decisions_select' : 'decisions_slow';
  }
  if (entry.type === 'substitution-issued') return 'substitutions_issued';
  if (entry.type === 'substitution') return 'substitutions_certified';
  if (entry.type === 'selector-abstain' || entry.type === 'selector-unmapped') return 'selector_abstentions';
  if (entry.type === 'dispatch-rejected') return 'dispatch_rejections';
  if (entry.type === 'boundary-error') return 'boundary_errors';
  return null;
}

/** A config field may be a plain value or a live source ({ get() }) from the loader. */
function read(field, fallback) {
  let value = field;
  for (let depth = 0; depth < 4; depth++) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object' && typeof value.get === 'function') {
      try {
        value = value.get();
        continue;
      } catch {
        return fallback;
      }
    }
    break;
  }
  return value === undefined || value === null ? fallback : value;
}

/**
 * Read one field of a config group. The loader resolves a declared group into a
 * plain object whose fields are live sources, so a group is indexed directly
 * rather than passed through read().
 */
function field(group, key, fallback) {
  if (!group || typeof group !== 'object') return fallback;
  return read(group[key], fallback);
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function policyGroup(config) {
  if (config && typeof config === 'object' && typeof config.get !== 'function') {
    if ('policy' in config && typeof config.policy === 'object') return config.policy;
    if ('enabled' in config) return config;
  }
  return read(config, {});
}

function policyOf(config) {
  const group = policyGroup(config);
  return {
    enabled: field(group, 'enabled', true) === true,
    version: POLICY_VERSION,
    maximum_candidates: clampInt(field(group, 'maximum_candidates', 16), 1, 16),
    maximum_fast_steps: clampInt(field(group, 'maximum_fast_steps', 8), 1, 16),
    maximum_public_bytes: clampInt(field(group, 'maximum_public_bytes', 65536), 1024, 65536),
    admission_threshold_tokens: clampInt(field(group, 'admission_threshold_tokens', 1024), 0, 65536),
  };
}

function shellToolsOf(config, ctx) {
  const declared = read(config?.shellTools, []);
  const explicit = Array.isArray(declared) ? declared.filter(tool => typeof tool === 'string' && SHELL_TOOLS.has(tool)) : [];
  if (explicit.length) return explicit;
  let names = [];
  try {
    names = (ctx.tools?.schemas?.() ?? []).map(tool => tool?.name).filter(tool => SHELL_TOOLS.has(tool));
  } catch {
    names = [];
  }
  return names.length ? names : [...SHELL_TOOLS];
}

/* ------------------------------------------------------------------------- *
 * Plugin
 * ------------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  const policyConfig = config?.policy ?? {};
  const selectorConfig = config?.selector ?? {};
  const shellTools = shellToolsOf(config, ctx);
  const resolvePolicy = () => policyOf(policyConfig);

  const receiptsPath = () => {
    const explicit = read(config?.receiptsFile, '');
    if (typeof explicit === 'string' && explicit.trim()) return explicit;
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'harnessmm', 'receipts.jsonl');
  };

  const record = (entry) => {
    try {
      const path = receiptsPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch {
      // Receipt durability must never break a model turn.
    }
  };

  /**
   * Per-session bookkeeping, keyed by a plain session id: llm/stream receives a
   * frozen request that carries sessionId and no agent, while tools/execute and
   * tools/result carry exec.agent.id. A string key is the one identity every
   * mount point can produce.
   */
  const sessions = new Map();

  const storeFor = (sessionId) => {
    const key = String(sessionId ?? 'session');
    let store = sessions.get(key);
    if (!store) {
      store = { turn: null, slowRequests: 0, counters: emptyCounters(), gate: 'idle', reason: null };
      sessions.set(key, store);
      while (sessions.size > STORE_LIMIT) sessions.delete(sessions.keys().next().value);
    }
    return store;
  };

  const recordFor = store => (entry) => {
    const counter = counterOf(entry);
    if (counter) store.counters[counter]++;
    if (entry.type === 'decision') {
      store.gate = entry.kind;
      store.reason = entry.reason ?? null;
    }
    record(entry);
  };

  ctx.tools.register({
    name: 'harnessmm_status',
    description: 'Read HarnessMM counters and the last decision of this session. Use when asked about HarnessMM status, or after a declared action graph was not used.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          gate: { type: 'string' },
          reason: { type: 'string' },
          ...Object.fromEntries(COUNTERS.map(key => [key, { type: 'integer' }])),
        },
        required: ['enabled', 'gate', 'reason', ...COUNTERS],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      const store = sessions.get(sessionIdOfExecution(exec));
      return {
        enabled: resolvePolicy().enabled,
        gate: store?.gate ?? 'idle',
        reason: store?.reason ?? '',
        ...(store?.counters ?? emptyCounters()),
      };
    },
  });

  if (read(config?.planSection, true) !== false) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: 10300,
      interpolate: false,
      text: () => {
        const policy = resolvePolicy();
        return policy.enabled ? planText(policy, shellTools) : '';
      },
    });
  }

  // ---- llm/stream: the model-to-tool boundary ------------------------------

  ctx.on('llm/stream', (options, next) => {
    const policy = resolvePolicy();
    if (!policy.enabled) return next();
    const sessionId = sessionIdOf(options);
    // The selector's own completion is a plain chat request with no session, so
    // it falls through here and never re-enters the boundary it was asked to
    // decide.
    if (!sessionId) return next();
    const store = storeFor(sessionId);
    return boundaryStream({
      ctx, options, next, sessionId, store, policy, selectorConfig, shellTools, record: recordFor(store),
    });
  });

  // ---- tools/execute: a substituted call is accepted only verbatim ---------

  ctx.on('tools/execute', async (payload, next) => {
    const policy = resolvePolicy();
    if (!policy.enabled) return next();
    const call = callOf(payload);
    if (!call || typeof call.id !== 'string' || !call.id.startsWith('chisel_')) return next();
    const sessionId = sessionIdOfExecution(payload);
    if (!sessionId) return next();
    const store = storeFor(sessionId);
    // tools/execute carries no message history, so the accepted graph comes from
    // the turn the boundary recorded, not from a fresh projection.
    const violation = violateDispatch({ projected: null, turn: store.turn, call, policy });
    if (violation) {
      recordFor(store)({ type: 'dispatch-rejected', call_id: call.id, reason: violation.violation });
      throw new Error('HarnessMM rejected a substituted call: ' + violation.violation);
    }
    if (store.turn) store.turn.steps = (store.turn.steps ?? 0) + 1;
    return next();
  });

  // ---- tools/result: decode the native receipt and settle the certificate --

  ctx.on('tools/result', (exec, result) => {
    const policy = resolvePolicy();
    if (!policy.enabled) return;
    const call = callOf(exec);
    if (!call || typeof call.id !== 'string') return;
    const sessionId = sessionIdOfExecution(exec);
    if (!sessionId) return;
    const store = storeFor(sessionId);
    const turn = store.turn;
    if (!turn) return;
    // The frozen result is the authoritative receipt; the rendered message the
    // next request sees is only a fallback, because it may have lost its exit
    // trailer and would then read as success.
    const receipt = publicReceipt({
      name: call.name,
      isError: result?.isError === true,
      text: textOf(result),
      canonical: canonicalOf(result),
    });
    rememberNativeReceipt(turn, call.id, {
      canonical: canonicalOf(result),
      isError: result?.isError === true,
      text: textOf(result),
    });
    if (!call.id.startsWith('chisel_') || !turn.pending.has(call.id)) return;
    turn.pending.delete(call.id);
    const meta = turn.pendingMeta.get(call.id);
    const certificate = {
      ...makeCertificate({
        turnId: turn.id,
        decisionId: meta?.decisionId ?? null,
        bankSha: turn.bank?.sha256 ?? null,
        candidateId: meta?.candidateId ?? null,
        predecessorId: meta?.predecessorId ?? null,
        predecessorReceiptHash: meta?.predecessorReceiptHash ?? null,
        bypassedCallbackId: meta?.bypassedCallbackId ?? null,
        tool: call.name,
        argumentsText: call.arguments,
        receiptHash: hashJson(receipt),
        selector: meta?.selector ?? null,
        probability: meta?.probability ?? null,
        usage: meta?.usage ?? null,
        slowTokens: turn.slowTokens ?? 0,
      }),
      native_receipt: receipt,
      amount_substituted_slow_callbacks: 1,
    };
    recordFor(store)({ type: 'substitution', ...certificate });
    turn.certificates += 1;
  });

  return { planText: () => planText(resolvePolicy(), shellTools) };
}

/* ------------------------------------------------------------------------- *
 * Boundary stream
 * ------------------------------------------------------------------------- */

async function* boundaryStream({ ctx, options, next, sessionId, store, policy, selectorConfig, shellTools, record }) {
  let stockStarted = false;
  let emitted = false;
  const startStock = () => {
    stockStarted = true;
    return next();
  };
  try {
    const inner = boundaryStreamInner({
      ctx, options, next: startStock, sessionId, store, policy, selectorConfig, shellTools, record,
    });
    for await (const chunk of inner) {
      emitted = true;
      yield chunk;
    }
  } catch (error) {
    // The host owns provider failures. Re-entering next() could repeat a paid
    // request, and appending a fresh stream to emitted chunks corrupts the turn.
    if (stockStarted) throw error;
    record({ type: 'boundary-error', turn_id: store.turn?.id ?? null, reason: String(error?.message ?? error) });
    if (emitted) throw error;
    yield* stockStream(next);
  }
}

function stockStream(next) {
  const produced = next();
  return produced && typeof produced[Symbol.asyncIterator] === 'function' ? produced : produced();
}

function newTurn(store, sessionId, gate) {
  store.slowRequests += 1;
  return {
    id: sessionId + ':turn-' + store.slowRequests,
    callbackId: sessionId + ':request-' + store.slowRequests,
    gate,
    steps: 0,
    certificates: 0,
    omitted: 0,
    executed: new Set(['root']),
    pending: new Set(),
    pendingMeta: new Map(),
    nativeReceipts: new Map(),
    bank: null,
    candidates: null,
    slowTokens: 0,
  };
}

/** Candidate labels this chain already ran, recovered from the issued call ids. */
function executedFromReceipts(receipts) {
  const executed = new Set(['root']);
  for (const message of receipts ?? []) {
    const id = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
    const label = /^chisel_[0-9a-f]{24}_([A-P])$/.exec(id);
    if (label) executed.add(label[1]);
  }
  return executed;
}

function boundaryStreamInner({ ctx, options, next, sessionId, store, policy, selectorConfig, shellTools, record }) {
  const projected = projectTurn(options.messages ?? [], options.tools ?? [], policy);
  let turn = store.turn;

  if (!projected) {
    // A slow request: fix the boundary facts before any chunk exists, so a
    // mid-turn projection can never be mistaken for an authoring step.
    turn = newTurn(store, sessionId, 'slow');
    store.turn = turn;
  } else if (!turn) {
    // A projected turn whose session was not observed while it was slow: the
    // host restarted mid-turn, or the plugin mounted late. The turn still needs
    // a record, or the issued call never reaches the guard and the sink.
    turn = newTurn(store, sessionId, 'resumed');
    store.turn = turn;
  }

  if (projected) {
    // The issued call id is derived from the bank hash, so a projected turn must
    // carry it even when this process never authored the bank.
    turn.bank = { sha256: projected.bank.sha256, bytes: projected.bank.bytes };
    turn.candidates = projected.bank.candidates;
    turn.gate = 'projected';
    turn.executed = executedFromReceipts(projected.receipts);

    const receiptMessage = options.messages.at(-1);
    const native = receiptMessage?.toolCallId
      ? turn.nativeReceipts.get(receiptMessage.toolCallId)
      : null;
    const receipt = publicReceipt(native
      ? {
        name: projected.tool ?? 'native_tool',
        isError: native.isError === true,
        text: native.text,
        canonical: SHELL_TOOLS.has(projected.tool) ? native.canonical : undefined,
      }
      : {
        name: projected.tool ?? 'native_tool',
        isError: receiptMessage?.isError === true,
        text: textOfMessage(receiptMessage),
        canonical: canonicalOfMessage(receiptMessage),
      });

    const survivors = projected.candidates.filter(candidate => {
      const check = localGuard(candidate, receipt);
      return check.known && check.eligible && !(candidate.dependency_ids ?? []).some(id => !turn.executed.has(id));
    });
    const decision = decide({
      projected,
      receipt,
      slowTokens: turn.slowTokens ?? 0,
      deterministic: survivors.length === 1,
      policy,
    });
    record({
      type: 'decision',
      turn_id: turn.id,
      kind: decision.kind,
      reason: decision.reason ?? null,
      eligible: decision.admission.eligible.map(item => item.node.candidate_id),
      rejected: decision.admission.rejected.map(item => ({ id: item.node.candidate_id, reason: item.reason })),
      position: projected.position,
      steps: projected.steps,
    });

    if (decision.kind === 'commit') {
      return emitSubstitution({
        turn, store, record, candidate: decision.candidate, payload: decision.payload,
        decisionId: decision.decisionId, selector: 'deterministic', probability: null,
        usage: decision.usage, policy,
      });
    }
    if (decision.kind === 'select') {
      if (field(selectorConfig, 'enabled', true) === false) {
        // A switched-off selector is a deliberate choice: never spend a model
        // call on the letter, hand the turn straight back to the slow actor.
        record({ type: 'selector-abstain', turn_id: turn.id, reason: 'selector-disabled', usage: null });
      } else {
        return selectStream({
          ctx, options, next, store, record, turn, decision, policy, selectorConfig,
        });
      }
    }
  }

  return authoringStream({ options, next, store, record, turn, policy });
}

/** The ordinary slow stream, plus bank extraction once it settled. */
async function* authoringStream({ options, next, store, record, turn, policy }) {
  const chunks = [];
  for await (const chunk of stockStream(next)) {
    chunks.push(chunk);
    yield chunk;
  }
  // The stock response has already been delivered. Bank bookkeeping can fail
  // without changing that response or asking the provider to generate it again.
  try {
    turn.slowTokens = usageOf(chunks);
    const bank = parseBank(messageOf(chunks), options.tools ?? [], { maxCandidates: policy.maximum_candidates });
    if (!bank || !bank.candidates.length) {
      turn.gate = bank ? 'empty-bank' : 'no-bank';
      return;
    }
    turn.bank = { sha256: bank.sha256, bytes: bank.bytes };
    turn.candidates = bank.candidates;
    turn.gate = 'bank-authored';
    record({
      type: 'bank',
      turn_id: turn.id,
      bank_sha256: bank.sha256,
      candidates: bank.candidates.length,
      public_bytes: bank.bytes,
    });
  } catch (error) {
    if (error instanceof BankContractError) {
      turn.gate = 'invalid-bank';
      record({ type: 'invalid-bank', turn_id: turn.id, reason: error.message });
    } else {
      record({ type: 'boundary-error', turn_id: turn.id, reason: String(error?.message ?? error) });
    }
  }
}

function selectStream({ ctx, options, next, store, record, turn, decision, policy, selectorConfig }) {
  return (async function* stream() {
    const completion = await oneSelection(ctx, selectorConfig, decision.payload, options);
    const fallback = () => authoringStream({ options, next, store, record, turn, policy });
    if (!completion || completion.label === '?') {
      record({
        type: 'selector-abstain',
        turn_id: turn.id,
        usage: completion?.usage ?? null,
        reason: completion ? (completion.failure ? 'selector-error' : 'abstained') : 'no-completion',
        failure: completion?.failure ?? null,
        raw: completion?.raw ?? null,
      });
      yield* fallback();
      return;
    }
    const candidate = decision.admission.eligible
      .map(item => item.node)
      .find(item => item.candidate_id === completion.label);
    if (!candidate) {
      record({ type: 'selector-unmapped', turn_id: turn.id, label: completion.label });
      yield* fallback();
      return;
    }
    yield* emitSubstitution({
      turn, store, record, candidate, payload: decision.payload, decisionId: decision.decisionId,
      selector: 'fast-selector', probability: completion.probability, usage: completion.usage, policy,
    });
  })();
}

async function* emitSubstitution({ turn, store, record, candidate, payload, decisionId, selector, probability, usage, policy }) {
  const argumentsText = JSON.stringify(candidate.arguments);
  const bankSha = turn.bank?.sha256 ?? hash(turn.id);
  const callId = nativeCallId(bankSha, candidate.candidate_id);
  const guard = localGuard(candidate, payload.receipt);
  if (!guard.eligible) {
    record({ type: 'substitution-aborted', turn_id: turn.id, reason: guard.reason });
    return;
  }
  // The callback that did not happen. The host exposes no request id, so the
  // id is the boundary request ordinal plus the substitution ordinal inside it;
  // it is stable, auditable, and never null.
  const bypassedCallbackId = turn.callbackId + ':omitted:' + turn.omitted;
  turn.omitted += 1;
  turn.pending.add(callId);
  turn.pendingMeta.set(callId, {
    decisionId,
    candidateId: candidate.candidate_id,
    predecessorId: candidate.predecessor_id,
    predecessorReceiptHash: hashJson(payload.receipt),
    bypassedCallbackId,
    selector,
    probability,
    usage,
  });
  turn.executed.add(candidate.candidate_id);
  record({
    type: 'substitution-issued',
    turn_id: turn.id,
    decision_id: decisionId,
    call_id: callId,
    candidate_id: candidate.candidate_id,
    tool: candidate.tool,
    selector,
    probability,
    bypassed_slow_callback_id: bypassedCallbackId,
    control_usage: usage,
  });
  // A substituted step is a turn no model authored, so it carries no native
  // thinking. Thinking-mode endpoints reject an assistant turn whose tool call
  // has no sibling thinking block, so this receipt-bound note is the sibling;
  // the host replays it verbatim on every later request. It states what
  // happened and never quotes a plan tag, so replay cannot be mistaken for an
  // authored bank.
  const thinking = 'HarnessMM replay: frozen candidate ' + candidate.candidate_id
    + ' matched its receipt guard, so ' + candidate.tool + ' ran without a new model decision.';
  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
  yield { type: 'reasoning-delta', index: 0, text: thinking };
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: callId,
    name: candidate.tool,
    argumentsDelta: argumentsText,
  };
  yield {
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: callId, name: candidate.tool, arguments: argumentsText },
  };
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
  void policy;
}

/* ------------------------------------------------------------------------- *
 * Selector — one label, host-owned route
 * ------------------------------------------------------------------------- */

function selectorRoute(selectorConfig, options) {
  const provider = field(selectorConfig, 'provider', '') || process.env.HARNESSMM_SELECTOR_PROVIDER || '';
  const model = field(selectorConfig, 'model', '') || process.env.HARNESSMM_SELECTOR_MODEL || '';
  if (provider && model) return { provider, model };
  // Default to the route the boundary request itself rides: it is the one route
  // this host has already proven answerable under the live profile.
  if (options?.provider && options?.model) return { provider: options.provider, model: options.model };
  return null;
}

async function oneSelection(ctx, selectorConfig, payload, options) {
  const route = selectorRoute(selectorConfig, options);
  if (!route) return { label: '?', usage: null, failure: { code: 'NO_ROUTE' } };
  const llm = ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') return { label: '?', usage: null, failure: { code: 'NO_LLM' } };
  const maxTokens = clampInt(field(selectorConfig, 'maxTokens', 1024), 1, 4096);
  const timeoutMs = clampInt(field(selectorConfig, 'timeoutMs', 20000), 1000, 120000);
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SELECTOR_SYSTEM }] },
    { role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] },
  ];
  const effort = await selectionReasoningEffort(llm, route, options);
  const base = effort ? { reasoningEffort: effort } : {};
  let last = { label: '?', usage: null, failure: { code: 'NO_ATTEMPT' } };
  for (const shape of [{ maxTokens, ...base }, { ...base }]) {
    last = await oneSelectionAttempt(llm, route, messages, shape, timeoutMs);
    // A completed answer — including a genuine '?' — ends the ladder. Only a
    // failed call is retried in the more conservative shape.
    if (!last.failure) return last;
  }
  return last;
}

async function selectionReasoningEffort(llm, route, options) {
  const inherited = options?.reasoningEffort;
  if (typeof inherited === 'string' && inherited.length > 0) return inherited;
  if (typeof llm?.resolveModelInfo !== 'function') return null;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
    if (efforts.length === 0) return null;
    return efforts[efforts.length - 1]?.id ?? null;
  } catch {
    return null;
  }
}

async function oneSelectionAttempt(llm, route, messages, shape, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const chunks = [];
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      signal: controller.signal,
      ...shape,
    })) {
      chunks.push(chunk);
    }
    const usage = usageObject(chunks);
    const terminal = chunks.findLast(chunk => chunk.type === 'finish');
    const kind = terminal?.reason?.kind;
    if (terminal && (kind === 'error' || kind === 'aborted')) {
      return { label: '?', usage, failure: terminal.reason.failure ?? { code: kind } };
    }
    const text = messageOf(chunks).content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim();
    const label = [...text].find(character => LABELS.includes(character) || character === '?') ?? '?';
    return { label, probability: null, usage, raw: text.slice(0, 32), failure: null };
  } catch (error) {
    return { label: '?', usage: null, failure: { code: 'THREW', message: String(error?.message ?? error) } };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- *
 * Payload utilities
 * ------------------------------------------------------------------------- */

function sessionIdOf(options) {
  const id = options?.sessionId;
  if (typeof id === 'string' && id.length > 0) return id;
  if (id !== null && typeof id === 'object' && typeof id.toString === 'function') {
    const text = String(id);
    if (text && text !== '[object Object]') return text;
  }
  const fallback = options?.metadata?.sessionId;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

function sessionIdOfExecution(exec) {
  const agent = exec?.agent ?? exec?.exec?.agent;
  const id = agent?.id ?? agent?.session?.id ?? exec?.sessionId;
  if (typeof id === 'string' && id.length > 0) return id;
  if (id !== null && typeof id === 'object' && typeof id.toString === 'function') {
    const text = String(id);
    if (text && text !== '[object Object]') return text;
  }
  return null;
}

function messageOf(chunks) {
  const parts = [];
  for (const chunk of chunks) {
    if (chunk?.type === 'block-end' && chunk.block) parts.push(chunk.block);
  }
  return { role: 'assistant', content: parts };
}

function usageOf(chunks) {
  return usageObject(chunks).totalTokens;
}

function usageObject(chunks) {
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const chunk of chunks) if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage;
  return usage;
}

function callOf(payload) {
  const candidates = [payload, payload?.exec, payload?.call, payload?.execution];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.name === 'string' && typeof entry.callId === 'string' && entry.arguments !== undefined) {
      return normalizeCall(entry.name, entry.callId, entry.arguments);
    }
  }
  return null;
}

function normalizeCall(name, id, args) {
  let text;
  if (typeof args === 'string') text = args;
  else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = '';
    }
  }
  return { id, name, arguments: text };
}

function textOf(payload) {
  const blocks = payload?.result?.content ?? payload?.content ?? payload?.result?.value?.content;
  if (Array.isArray(blocks)) {
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
    if (text) return text;
  }
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.result?.text === 'string') return payload.result.text;
  return '';
}

function textOfMessage(message) {
  if (!message) return '';
  if (Array.isArray(message.content)) {
    return message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n');
  }
  if (typeof message.content === 'string') return message.content;
  return '';
}

function canonicalOf(payload) {
  return payload?.result?.value ?? payload?.value ?? payload?.canonical ?? undefined;
}

function rememberNativeReceipt(turn, callId, native) {
  if (!(turn?.nativeReceipts instanceof Map)) return;
  turn.nativeReceipts.set(callId, native);
  while (turn.nativeReceipts.size > 32) {
    turn.nativeReceipts.delete(turn.nativeReceipts.keys().next().value);
  }
}

function canonicalOfMessage(message) {
  if (!message || typeof message !== 'object') return undefined;
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part.result?.value ?? part.value ?? part.canonical;
    if (candidate && typeof candidate === 'object') return candidate;
  }
  const candidate = message.result?.value ?? message.value ?? message.canonical;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}