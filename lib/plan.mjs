/**
 * The authoring instruction — the dialect the slow actor has to speak.
 *
 * Kept apart from the host plugin so a test can snapshot the text and so a
 * deployment can read it without loading the boundary.
 */

import { LABELS, PLAN_CLOSE, PLAN_OPEN } from './protocol.mjs';

/**
 * Render the prompt section for the current policy.
 *
 * @param {{ maximum_candidates: number, maximum_fast_steps: number,
 *           admission_threshold_tokens: number }} policy
 * @param {string[]} shellTools the shell tools this profile actually mounts
 */
export function planText(policy, shellTools) {
  const tools = Array.isArray(shellTools) && shellTools.length ? shellTools : ['bash'];
  const shellList = tools.length === 1
    ? tools[0]
    : tools.slice(0, -1).join(', ') + ' or ' + tools.at(-1);
  const last = LABELS[Math.min(16, Math.max(1, policy.maximum_candidates)) - 1];
  const example = JSON.stringify({
    candidates: [
      {
        candidate_id: 'A',
        predecessor_id: 'root',
        tool: tools[0],
        arguments: { description: 'Run the test suite', command: 'python -m pytest -q' },
        guard: { exit_code: 0 },
        required_receipt_fields: ['exit_code'],
        expected_local_cost: { selector_upper_tokens: 8192 },
        dependency_ids: [],
      },
      {
        candidate_id: 'B',
        predecessor_id: 'A',
        tool: tools[0],
        arguments: { description: 'Show the diff', command: 'git --no-pager diff' },
        guard: { exit_code: 0 },
        required_receipt_fields: ['exit_code'],
        expected_local_cost: { selector_upper_tokens: 8192 },
        dependency_ids: ['A'],
      },
    ],
  }, null, 2);

  return [
    '## Executable action graph (HarnessMM)',
    '',
    'HarnessMM is active for this session. When you are about to act, you may also declare a frozen graph of *future* native calls next to the single native call you are making now. Later steps reuse that graph: a receipt-local guard is checked against the real tool result, and a surviving candidate then runs through the same native tool instead of asking you to reason again. When the graph is exhausted, a guard fails, or an action would need new judgement, control returns to you — write a fresh graph from the current state.',
    '',
    '### Declaring a graph',
    '',
    'Put exactly one ' + PLAN_OPEN + '...' + PLAN_CLOSE + ' block in the assistant text of a turn whose single tool call is the first ("root") action of the graph, and write the block before that tool call. Example:',
    '',
    '```',
    PLAN_OPEN,
    example,
    PLAN_CLOSE,
    '```',
    '',
    'A declaration must be bare assistant text. A ' + PLAN_OPEN + ' body inside a code fence is documentation, not a declaration, and is ignored.',
    '',
    '- `tool` is `' + shellList + '`, or any tool in your visible catalog that the graph continues.',
    '- `candidate_id` is a unique letter in A-' + last + '; `predecessor_id` is `root` or an id declared earlier in the same list.',
    '- `arguments` is the complete literal argument object for that native tool, decided now. Never defer a decision into a placeholder: an argument that depends on output you have not seen means the action does not belong in the graph.',
    '- `guard` is a conjunction over fields of the immediate predecessor receipt: `exit_code` (shell status), `stdout_contains`, `stdout_equals`, `stderr_empty`, `json_equals` (`{"path":[keys],"value":…}` resolved against `stdout` parsed as JSON), and `ok`. Only receipt-local, syntactic conditions are allowed — no judgement about what the output means.',
    '- `required_receipt_fields` lists every receipt field the guard reads: `exit_code`, `stdout`, `stderr`, `ok`.',
    '- `expected_local_cost.selector_upper_tokens` is your upper bound on what the selector step itself may cost. The controller charges the smaller of that bound and its shipped fast-call ceiling, and admits the step only when the slow turn it replaces exceeded that charge by more than the admission threshold of ' + policy.admission_threshold_tokens + ' tokens — so declaring more than the selector actually needs makes admission less likely, never more. Declare a realistic bound; do not inflate it.',
    '- `dependency_ids` lists earlier candidates this action relies on.',
    '',
    'Declare 2-8 genuinely certain future calls; at most ' + policy.maximum_candidates + '. When nothing is safely predictable write ' + PLAN_OPEN + '{"candidates":[]}' + PLAN_CLOSE + ' and continue normally — the graph is optional and an empty one costs nothing.',
    '',
    '### What you will see afterwards',
    '',
    'A substituted step appears in the transcript as an assistant tool call whose id starts with `chisel_`. You did not author that step: the controller selected a candidate from your graph and replayed it with exactly the arguments you froze. Treat the result as your own and continue. Only a new root call asks for a fresh decision — do not "repair" a graph that already ran.',
    '',
    'At most ' + policy.maximum_fast_steps + ' substitution steps run per graph. Call `harnessmm_status` when you want the counters for this session, or after a graph was refused.',
    '',
    'A zero exit code never proves the task is complete. A prepared action that deletes, moves, or overwrites must carry a verified absolute path in its own `arguments`.',
  ].join('\n');
}
