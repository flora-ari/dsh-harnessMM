/**
 * The plugin configuration form.
 *
 * schemastery is the host's own schema library, so the same object drives loader
 * validation, the settings form and the locale labels in locale/*.json.
 */

import z from '@deepseek-ai/schemastery';

/**
 * schemastery < 3.18.5 has no .volatile(); a config field that changes without
 * a remount must be declared volatile where the installed version supports it.
 */
function live(field) {
  return typeof field.volatile === 'function' ? field.volatile() : field;
}

/**
 * A bounded integer. The default is the policy default, never the lower bound:
 * a bound is a validation limit, so deriving a default from it silently
 * narrows the policy.
 */
const intField = (fallback, min, max) => live(z.number().default(fallback).min(min).max(max));

export const Config = z.object({
  policy: z.object({
    enabled: live(z.boolean().default(true)),
    maximum_candidates: intField(16, 1, 16),
    maximum_fast_steps: intField(8, 1, 16),
    maximum_public_bytes: intField(65536, 1024, 65536),
    admission_threshold_tokens: intField(1024, 0, 65536),
  }).default({}),
  selector: z.object({
    enabled: live(z.boolean().default(true)),
    provider: live(z.string().default('')),
    model: live(z.string().default('')),
    // A reasoning model spends tokens on hidden thinking before it can emit the
    // single label, so a one-token budget starves the answer.
    maxTokens: live(z.number().default(1024)),
    timeoutMs: live(z.number().default(20000)),
  }).default({}),
  shellTools: live(z.array(z.string()).default([])),
  planSection: live(z.boolean().default(true)),
  receiptsFile: live(z.string().default('')),
}).description('HarnessMM guarded decision reuse for the native tool surface.');
