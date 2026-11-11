# Changelog

## 1.1.0

- **Settings switch.** The package now ships a client half (`dsh.client`,
  `exports["./client"]`). It registers a HarnessMM row in the Settings
  navigation whose only control is an inline-prompt Y/N switch — green when on,
  red when off, the letter inside the track opposite the thumb. The switch writes
  `policy.enabled` through `ctx.configForms`, the same settings namespace the
  built-in plugin configuration page edits, so the choice persists per profile.
- Host state is released with the plugin fiber: reloading a profile no longer
  keeps the previous session map alive.
- Client-half contract tests: module id, Cordis client shape, section
  registration, injected form face, and the exact write the switch performs.

## 1.0.0

First standalone release of HarnessMM for DeepSeek Harness.

- One frozen action graph per slow turn (`<CHISEL_PLAN>`), parsed under a closed
  contract: unique `A`-`P` labels, earlier-only predecessors and dependencies,
  literal arguments, and guards restricted to receipt-local fields.
- Receipt-local guards over the harness receipt dialect (`exit_code`,
  `stdout_contains`, `stdout_equals`, `stderr_empty`, `json_equals`, `ok`),
  with the unknown-versus-false distinction kept intact.
- Deterministic commit for one surviving candidate; a one-character selector for
  several, admitted only above the net-saving threshold.
- Substitution at `llm/stream`, verified at `tools/execute` against the authored
  literal action, settled at `tools/result`.
- `harnessmm-dsh-certificate/v1` receipts, one bypassed callback each.
- `harnessmm_status` tool for per-session counters and the last gate.
- Bundle patch, English and Chinese locale files, and a 54-case offline suite.
- Verified end-to-end on a real harness loop: two chained substitutions, three
  model requests instead of five.

Fixes carried over from earlier experimental adapters:

- `bypassed_slow_callback_id` is synthesised from the boundary request ordinal
  and is never null; the certificate names the callback that did not happen.
- Counter and certificate bookkeeping share one per-session store, so
  `harnessmm_status` and the receipt file cannot disagree.
- The status tool's schema uses single type strings, which the harness tool
  registry requires.