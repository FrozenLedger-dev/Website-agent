/**
 * Model connectivity and capability probe.
 *
 * Verifies what the agent depends on beyond a plain completion: that the
 * configured provider is reachable, and that structured output actually
 * conforms to a supplied schema. Run before debugging orchestration failures —
 * a broken key or an unsupported parameter surfaces here in one call instead of
 * three layers down.
 *
 *   pnpm model:check
 *   PROVIDER=openai pnpm model:check
 */
import * as z from 'zod/v4';
import { ModelClient, ModelRefusal, modelFor, providerName } from '@statxai/agents';

// Exercises every constraint kind the contracts use — array minItems > 1,
// string minLength, a regex pattern, an enum, and an optional property — so the
// probe fails here if either provider's accepted schema surface narrows.
const Probe = z.object({
  tagline: z.string().min(1),
  sections: z.array(z.string().min(1)).min(2),
  ref: z.string().regex(/^QA-\d{3,}$/),
  tone: z.enum(['professional', 'friendly']),
  aside: z.string().optional(),
});

const provider = providerName();
const credential = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

if (!process.env[credential]) {
  console.error(`\n  FAIL  ${credential} is not set (provider: ${provider}).\n`);
  process.exit(1);
}

try {
  const started = Date.now();
  const result = await new ModelClient().call({
    tier: 'sol',
    label: 'probe',
    system: 'You plan small business websites.',
    schema: Probe,
    maxTokens: 4_000,
    effort: 'low',
    prompt:
      'A plumbing company in Leeds. Give a tagline, three homepage section names, ' +
      'a reference id of the form QA-014, and a tone.',
  });

  console.log(`\n  provider      ${provider}`);
  console.log(`  configured    ${modelFor('sol', provider)}`);
  console.log(`  served by     ${result.model}`);
  console.log(`  structured    valid (${result.value.sections.length} sections)`);
  console.log(`  optional      ${result.value.aside === undefined ? 'absent, as declared' : 'present'}`);
  console.log(`  tokens        ${result.inputTokens} in / ${result.outputTokens} out`);
  console.log(`  latency       ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\n  OK    model access and structured output are working.\n`);
} catch (error) {
  if (error instanceof ModelRefusal) {
    console.error(`\n  FAIL  Request refused (${error.category ?? 'uncategorised'}).\n`);
  } else {
    console.error(`\n  FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
