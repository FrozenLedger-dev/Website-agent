/**
 * JSON Schema projections of the contracts that models must emit.
 *
 * Zod stays the single source of truth; JSON Schema is derived, never authored.
 * These are what Stage 2 hands to a model as a structured-output contract, so
 * malformed responses fail at the tool-call layer rather than deep inside the
 * job engine.
 *
 * Cross-field rules (see applyOutcomeRules in review.ts) are NOT representable
 * in JSON Schema. Shape is constrained here; consistency is enforced by parsing
 * the response with the corresponding Zod schema afterwards.
 */
import * as z from 'zod/v4';
import { JobSpec } from './job.js';
import { ReviewOutcomeInputBase } from './review.js';

/**
 * `toJSONSchema` is overloaded — one signature takes a schema, another takes a
 * registry and returns a map. `ReturnType<>` resolves to the registry overload,
 * so the type is taken from zod's own namespace instead.
 */
export type JsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * JSON Schema keywords the structured-output validator rejects outright.
 *
 * Zod emits several of these from ordinary constraints — `.min(2)` on an array
 * becomes `minItems: 2`, `.min(1)` on a string becomes `minLength: 1` — and the
 * request fails with a 400 rather than degrading. They are stripped on the way
 * out; the corresponding Zod schema still enforces every one of them when the
 * response is parsed, so nothing is actually relaxed. The model is constrained
 * on shape, the platform on everything else.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'minItems' && typeof value === 'number' && value > 1) {
      // Clamped rather than dropped: "non-empty" is the load-bearing half of
      // the constraint and is the one value the validator accepts.
      out[key] = 1;
      continue;
    }
    out[key] = sanitize(value);
  }
  return out;
}

/** Project a Zod schema to a JSON Schema the structured-output API accepts. */
export function toModelSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/**
 * Strict-mode projection.
 *
 * Some providers enforce a stricter subset: every property of every object must
 * appear in `required`, and `additionalProperties` must be false. Optional
 * fields are therefore expressed as nullable-and-required rather than omitted —
 * the model returns `null` where it has nothing to say, and {@link stripNulls}
 * turns those back into absent keys so the Zod schema's `.optional()` still
 * validates them.
 */
export function toStrictModelSchema(schema: z.ZodType): Record<string, unknown> {
  return strictify(toModelSchema(schema)) as Record<string, unknown>;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) out[key] = strictify(value);

  const properties = out['properties'] as Record<string, unknown> | undefined;
  if (out['type'] === 'object' && properties) {
    const names = Object.keys(properties);
    const previouslyRequired = new Set((source['required'] as string[] | undefined) ?? []);

    for (const name of names) {
      if (previouslyRequired.has(name)) continue;
      properties[name] = nullable(properties[name]);
    }

    out['required'] = names;
    out['additionalProperties'] = false;
  }

  return out;
}

/** Widen a schema to accept null, however its type is expressed. */
function nullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  const node = schema as Record<string, unknown>;

  if (typeof node['type'] === 'string') {
    return { ...node, type: [node['type'], 'null'] };
  }
  if (Array.isArray(node['type'])) {
    return node['type'].includes('null') ? node : { ...node, type: [...node['type'], 'null'] };
  }
  // $ref, anyOf and friends cannot take a type keyword alongside them.
  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Drop null-valued keys so a nullable-required response validates against a
 * schema that declares those fields optional.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    out[key] = stripNulls(item);
  }
  return out as T;
}

/** Contract a Terra reviewer must satisfy when returning a verdict (§7). */
export function reviewOutcomeJsonSchema(): Record<string, unknown> {
  return toModelSchema(ReviewOutcomeInputBase);
}

/** Contract Sol must satisfy when emitting a job for a worker (§4). */
export function jobSpecJsonSchema(): Record<string, unknown> {
  return toModelSchema(JobSpec);
}

export const MODEL_OUTPUT_SCHEMAS = {
  review_outcome: reviewOutcomeJsonSchema,
  job_spec: jobSpecJsonSchema,
} as const;
