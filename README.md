# dsh-harnessMM

**HarnessMM for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Guarded decision reuse over the native tool surface: the model authors one frozen action graph,
every candidate carries a receipt-local guard, and a certified native substitution replaces the
slow reasoning callback when its guard already holds.

Paper: **HarnessMM: Recursive Self-Improvement for Harness Token Efficiency**
([arXiv:2610.32813](https://arxiv.org/abs/2610.32813)) by Yuhua Jiang, Chang Xu, Feifei Gao and Li Zhao.
Reference implementation: [YuhuaJiang2002/HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM).
Sibling port for pi: [jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm).

---

## The idea in one screen

A slow model call is expensive. Most of what it does at step *n* is re-derive a decision it already
made at step *n-1*. HarnessMM reuses that decision instead:

1. **Author once.** The slow actor writes an Executable Decision Graph (EDG) next to its one root
   tool call. Every node is a *fully literal* future native call plus a *receipt-local* guard.
2. **Gate on the receipt.** After a tool result arrives, each candidate guard is evaluated against
   that public receipt only — `exit_code == 0`, `stdout_contains "PASS"`, and so on. No
   semantics, no judgement about what the output means.
3. **Substitute the callback.** A surviving candidate runs through the ordinary native executor
   instead of asking the model again. One surviving candidate commits deterministically; several go
   through a one-character selector.
4. **Certify.** Every substitution is recorded as a certificate that binds the graph hash, the
   candidate, the exact arguments, the exact native receipt and the reasoning callback that did
   *not* happen. The graph exhausts back into the ordinary slow path.

```
model turn N   <CHISEL_PLAN> A -> B   +   root command
               root executes --------------------------> receipt
               A: guard(receipt) holds ---------------> receipt   (no model call)
               B: guard(receipt) holds ---------------> receipt   (no model call)
               graph exhausted -----------------------> slow actor resumes
```

The paper's third pillar, recursive self-improvement, is an offline pipeline over datasets and
graders. A runtime plugin does not implement it, and this one does not claim to.

## What this plugin actually hooks

HarnessMM needs one thing from a harness: the ability to answer a reasoning request with a tool call
the model did not author. DeepSeek Harness has exactly that seam.

| Hook | Role |
| --- | --- |
| `systemPrompt.section` | injects the `CHISEL_PLAN` authoring dialect, bound to the shell tools the profile actually mounts |
| `llm/stream` | replaces a settled reasoning request with one certified native tool call |
| `tools/execute` | admits a substituted call only on exact literal equality with the authored node |
| `tools/result` | decodes the real result into a public receipt and settles the certificate |
| `tools.register` | adds `harnessmm_status`, so a session can read its own counters and last gate |

Nothing here replaces the native executor, the scorer or provider accounting. A substituted action
runs through the ordinary tool pipeline, so the loop renders its card, logs its result and bills its
usage itself. The controller never widens the action space; it only replays an action the model
already froze.

## Install

From a checkout or a local directory:

```sh
dsh plugin --profile desktop  add /path/to/dsh-harnessMM
dsh plugin --profile web      add /path/to/dsh-harnessMM
dsh plugin --profile headless add /path/to/dsh-harnessMM
```

The package ships a bundle patch (`cordis.patch.yml`), so `dsh plugin add` inserts the row
and the controller is on immediately. It declares `@deepseek-ai/schemastery` as a peer
dependency, the same contract the official plugin packages use; pnpm's default
`auto-install-peers` supplies it for a git or registry install.

A **local-path** install is a link, and pnpm does not resolve a linked package's peers. Run
`npm install` once in the plugin directory first, so `@deepseek-ai/schemastery` resolves from
there; otherwise the row activates but the module import fails with `ERR_MODULE_NOT_FOUND`.

To manage it by hand, add the same row to a profile patch:

```yaml
- insert:
    - id: harnessmm
      name: 'dsh-harnessmm'
      config:
        policy:
          enabled: true
```

A patch layer *replaces* a row's whole `config`; it never deep-merges. To change one knob,
restate the full block.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `policy.enabled` | `true` | gate for every hook; off means the stock loop runs untouched |
| `policy.maximum_candidates` | `16` | candidates per bank, labels `A`-`P` |
| `policy.maximum_fast_steps` | `8` | substituted steps before the graph exhausts |
| `policy.maximum_public_bytes` | `65536` | ceiling on the state a selector or a guard may see |
| `policy.admission_threshold_tokens` | `1024` | net saving a *selector-assisted* step must clear |
| `selector.enabled` | `true` | off sends a multi-candidate step straight back to the slow actor |
| `selector.provider` / `.model` | `''` | empty reuses the boundary request's own route |
| `selector.maxTokens` | `1024` | a reasoning model thinks before it emits the label |
| `selector.timeoutMs` | `20000` | selector call deadline |
| `shellTools` | `[]` | empty auto-detects `bash`/`pwsh` from the live catalog |
| `planSection` | `true` | inject the authoring section |
| `receiptsFile` | `''` | empty writes to `$DSH_HOME/harnessmm/receipts.jsonl` |

### Admission

A substitution is admitted only when the slow turn it replaces would have cost more than the fast
call replacing it, by at least `policy.admission_threshold_tokens`. With `n` the slow
turn's own usage:

- one surviving candidate -> committed deterministically, `n` is irrelevant;
- several surviving candidates -> admitted when `n - selector_upper_bound > threshold`, where
  the upper bound is clamped to 512 tokens.

The paper's 1024 is the default and the conservative direction. A single surviving candidate is
never gated, which is what makes the controller useful on steps cheaper than the floor.

## The authoring contract

One bank per turn, in bare assistant text (a fenced block is documentation), next to exactly one
root tool call:

```text
<CHISEL_PLAN>{"candidates":[
  {"candidate_id":"A","predecessor_id":"root","tool":"pwsh",
   "arguments":{"description":"Run the tests","command":"npm test"},
   "guard":{"exit_code":0},"required_receipt_fields":["exit_code"],
   "expected_local_cost":{"selector_upper_tokens":8192},"dependency_ids":[]},
  {"candidate_id":"B","predecessor_id":"A","tool":"pwsh",
   "arguments":{"description":"Show the diff","command":"git --no-pager diff"},
   "guard":{"exit_code":0,"stdout_contains":"diff"},"required_receipt_fields":["exit_code","stdout"],
   "expected_local_cost":{"selector_upper_tokens":8192},"dependency_ids":["A"]}
]}</CHISEL_PLAN>
```

Enforced by the parser, and therefore by the tests:

- labels are unique `A`..`P`; `predecessor_id` is `root` or an earlier label;
  `dependency_ids` must already be declared;
- the node key set is closed — an extra key is a contract violation, not a hint;
- `arguments` are fully literal: a `${...}` or `{{...}}` placeholder is refused,
  because an argument that depends on unseen output is not a frozen decision;
- guards are limited to `ok`, `exit_code`, `stdout_contains`, `stdout_equals`,
  `stderr_empty`, `json_equals`; every guard field must also be listed in
  `required_receipt_fields`, so a guard can never read a field the receipt may omit;
- a candidate may not repeat the root action;
- exactly one bank and exactly one root call per turn. The same JSON drafted in reasoning and
  restated in the answer counts as one declaration; two *different* plans do not.

## Receipts and certificates

One JSON object per line in `receiptsFile`:

| type | meaning |
| --- | --- |
| `bank` | a slow turn declared a valid action bank |
| `decision` | the gate received a receipt; lists eligible and rejected candidates with reasons |
| `substitution-issued` | a native call was emitted in place of the slow callback |
| `substitution` | the certificate, bound to the exact native result |
| `invalid-bank` | the declaration violated the closed contract |
| `boundary-error` | the stream controller failed; recorded, never hidden |
| `dispatch-rejected` | `tools/execute` refused a mutated or out-of-graph call |
| `selector-abstain` / `selector-unmapped` | the selector declined; the slow path resumed |

Receipts are canonicalised before a guard sees them: CRLF becomes LF, one trailing newline is
dropped, and the renderer's own status trailer (`[exit code: N]`, `[output truncated; ...]`)
is read for the exit code and then removed. Guards therefore compare program output, not shell
chrome.

A certificate (`harnessmm-dsh-certificate/v1`) carries the paper's six fields and the audited
counts:

```json
{
  "schema": "harnessmm-dsh-certificate/v1",
  "graph_hash": "...", "decision_id": "...", "candidate_id": "A", "predecessor_id": "root",
  "predecessor_receipt_hash": "...", "bypassed_slow_callback_id": "session-...:request-1:omitted:0",
  "exact_native_tool": "pwsh", "exact_arguments": "{\"description\":\"...\",\"command\":\"...\"}",
  "native_action_hash": "...", "native_receipt_hash": "...",
  "native_receipt": {"status":"PARSED","is_error":false,
    "value":{"tool":"pwsh","ok":true,"exit_code":0,"stdout":"...","stderr":"","truncated":false}},
  "selector": "deterministic", "control_usage": {"inputTokens":0,"outputTokens":0,"totalTokens":0},
  "slow_request_tokens_at_authoring": 1800,
  "amount_substituted_slow_callbacks": 1, "valid_substitution": true
}
```

`bypassed_slow_callback_id` is always present. The host exposes no provider request id, so the
plugin synthesises a stable one from the boundary request ordinal and the substitution ordinal
inside it. A certificate that named no bypassed callback would not be a certificate.

The claim is deliberately narrow: **one bypassed callback inside this agent loop**. There is no
episode-level counterfactual here, and these receipts must not be compared against the paper's
benchmark run identities.

## Verified on a real harness loop

`test/live-headless.mjs` drives the real CLI, the real native shell executor and the real
session log against a scripted Messages endpoint on localhost. The scenario declares a two-step
graph; the root receipt satisfies `A`, and `A`'s receipt satisfies `B`.

```text
PASS  live harness run
  model requests      : 3 (2 substituted steps skipped)
  substituted calls   : chisel_145bd23d728830b089827aa8_A, chisel_145bd23d728830b089827aa8_B
  certificates        : A session-...:request-1:omitted:0 | B session-...:request-1:omitted:1
  status              : {"enabled":true,"gate":"commit","banks_authored":1,
                         "decisions_commit":2,"substitutions_issued":2,"substitutions_certified":2, ...}
```

Two adjacent behaviours are covered by the unit and fake-host suites: a guard that does not hold
hands the turn back with `{"kind":"slow","reason":"no_eligible_candidate"}`, and a mutated
`chisel_` call is refused before the executor runs.

```sh
node test/live-headless.mjs --dsh /path/to/dsh-or-bin.js --tool pwsh
```

## Tests

```sh
npm install
npm test          # protocol contract + fake-host boundary, 54 cases, no provider access
npm run test:live # optional end-to-end run, needs a harness CLI
```

The protocol suite covers receipt decoding, every guard field, the unknown-versus-false distinction,
admission below and above the threshold, the closed bank contract, transcript projection, decision
shaping, dispatch binding and the certificate fields. The fake-host suite loads `lib/index.js`
against a mock context and drives the real handlers: authoring, deterministic substitution, selector
substitution, guard fallback, dispatch rejection and the status tool.

## Deliberate differences from the reference implementation

The reference talks to a benchmark `terminal` tool over an SDK bridge. A DSH profile has
neither, so this port reproduces the protocol, not the paper's harness:

- **Receipt dialect.** Shell tools are `pwsh`/`bash` with a required `description`,
  and results arrive as rendered text, so the guard field is `exit_code` and receipts are
  decoded rather than `JSON.parse`d.
- **Selector.** No logprobs are exposed, so the selector is a one-character completion validated
  against the offered labels; anything else is an abstention.
- **Cost model.** The selector is capped at 512 tokens instead of the author's re-decision estimate,
  and the admission threshold is a policy field rather than a constant.
- **Certificate scope.** One callback per certificate, never an episode counterfactual.
- **No RSI.** Recursive self-improvement lives in the reference repo's offline pipeline. This plugin
  implements the runtime adapter only.
- **No history compaction.** The authored bank stays in the transcript. Removing it would change
  what the loop replays, which this version does not attempt.

## Safety

- Guards are data, never code; a guard that cannot be read defers to the model instead of guessing.
- `tools/execute` re-checks every `chisel_` call against the authored literal action, so a
  mutated argument cannot reach the native executor even if it appears in the stream.
- The controller preserves the profile's permissions and action space and never widens them.
- Receipt durability is best-effort: a receipts file that cannot be written never breaks a turn.

## License

Apache-2.0. HarnessMM is research code by Yuhua Jiang, Chang Xu, Feifei Gao and Li Zhao; see
[NOTICE](NOTICE) and [CITATION.bib](CITATION.bib).

```bibtex
@misc{jiang2026harnessmmrecursiveselfimprovementharness,
  title={HarnessMM: Recursive Self-Improvement for Harness Token Efficiency},
  author={Yuhua Jiang and Chang Xu and Feifei Gao and Li Zhao},
  year={2026}, eprint={2610.32813}, archivePrefix={arXiv}, primaryClass={cs.AI},
  url={https://arxiv.org/abs/2610.32813}
}
```
