/**
 * Luna — focused repair (v1.2 §3).
 *
 * Receives one defect with a clear acceptance test and fixes the smallest
 * reasonable scope. §3's table is explicit about the boundary: "fix horizontal
 * overflow on the homepage at 375px", never "improve the entire mobile
 * experience". The prompt enforces that, and the orchestrator enforces it again
 * by only accepting files the repair was scoped to touch.
 */
import { BuildOutput, type BusinessProfile } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Luna. You perform one narrow, surgical repair.

You are given a single defect, the file or files it lives in, and the test that will prove
it is fixed. Fix exactly that. Return the complete corrected contents of only the files you
actually changed.

Boundaries:
- Do not redesign, refactor, restructure, or "improve while you are in there".
- Do not touch files unrelated to this defect.
- Do not introduce new claims about the business. If the fix needs a fact, take it from
  the business profile; if the profile does not have it, rewrite so the claim is not made.
- Preserve everything about the file that was not part of the defect, including formatting
  and the shared layout.
- No placeholder text, no external image references, no 555 phone numbers.

THE PROJECT

Next.js App Router, TypeScript, Tailwind v4, shadcn/ui, static export. Your repair must
still compile — a broken import or a missing component fails the build and wastes the
repair.

- Only these shadcn components exist, imported from "@/components/ui/<name>":
  accordion  badge  button  card  input  label  separator  sheet  textarea
- Internal links use next/link, never <a>.
- Pages are server components; "use client" belongs only on an interactive component
  under components/site/.
- You may write app/** and components/site/** only. package.json, config files, lib/ and
  components/ui/ are owned by the platform and writes to them are refused.

A defect's location is where the problem is *visible* — usually a page in the built
export, like "about.html#materials". The files you are given are the source that produced
it. Fix the source. When the location is a page but the cause is in the shared shell, fix
app/layout.tsx instead; it is supplied for exactly that reason.

Return full file contents, not a diff or a fragment.`;

export interface RepairTask {
  id: string;
  category: string;
  severity: string;
  location: string;
  reason: string;
  acceptanceTest: string;
}

export async function repairDefect(
  client: ModelClient,
  profile: BusinessProfile,
  task: RepairTask,
  files: readonly { path: string; contents: string }[],
) {
  const rendered = files.map((f) => `=== FILE: ${f.path} ===\n${f.contents}`).join('\n\n');

  return client.call({
    tier: 'luna',
    label: `luna:repair:${task.id}`,
    system: SYSTEM,
    schema: BuildOutput,
    // Headroom for one full page plus reasoning. `max_tokens` caps thinking and
    // output together, so a page-sized response needs well above its own size.
    maxTokens: 48_000,
    effort: 'medium',
    prompt: `Repair this single defect.

DEFECT ${task.id} (${task.severity}, ${task.category})
Location: ${task.location}
Problem:  ${task.reason}
Proves the fix: ${task.acceptanceTest}

BUSINESS PROFILE (the only source of factual claims)
${JSON.stringify(profile, null, 2)}

FILES IN SCOPE
${rendered}`,
  });
}
