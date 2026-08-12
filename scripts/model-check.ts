/**
 * Model connectivity and capability probe.
 *
 * Verifies the two things the agent depends on beyond a plain completion:
 * structured output actually conforms to a supplied JSON Schema, and adaptive
 * thinking is accepted. Run before debugging orchestration failures — a broken
 * key or an unsupported parameter surfaces here in one call instead of three
 * layers down.
 *
 *   pnpm model:check
 */
import Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';
import { toModelSchema } from '@statxai/contracts';

// Deliberately exercises every constraint kind the contracts use — array
// minItems > 1, string minLength, a regex pattern, and an enum — so the probe
// fails here if the accepted schema surface ever narrows again.
const Probe = z.object({
  tagline: z.string().min(1),
  sections: z.array(z.string().min(1)).min(2),
  ref: z.string().regex(/^QA-\d{3,}$/),
  tone: z.enum(['professional', 'friendly']),
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  FAIL  ANTHROPIC_API_KEY is not set.\n');
  process.exit(1);
}

const client = new Anthropic();

try {
  const started = Date.now();
  const res = await client.messages.create({
    model: process.env.MODEL_SOL ?? 'claude-opus-5',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: toModelSchema(Probe) },
    },
    messages: [
      {
        role: 'user',
        content:
          'A plumbing company in Leeds. Give a tagline, three homepage section names, ' +
          'a reference id of the form QA-014, and a tone.',
      },
    ],
  });

  if (res.stop_reason === 'refusal') {
    console.error(`\n  FAIL  Request refused (${res.stop_details?.category ?? 'unknown'}).\n`);
    process.exit(1);
  }

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Parse with Zod rather than trusting the schema was honoured: JSON Schema
  // constrains shape, not the cross-field rules the contracts rely on.
  const parsed = Probe.parse(JSON.parse(text));

  console.log(`\n  model         ${res.model}`);
  console.log(`  stop_reason   ${res.stop_reason}`);
  console.log(`  structured    valid (${parsed.sections.length} sections)`);
  console.log(`  tokens        ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
  console.log(`  latency       ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\n  OK    model access and structured output are working.\n`);
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error('\n  FAIL  Authentication rejected — check ANTHROPIC_API_KEY.\n');
  } else if (error instanceof Anthropic.APIError) {
    console.error(`\n  FAIL  API error ${error.status}: ${error.message}\n`);
  } else {
    console.error(`\n  FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
