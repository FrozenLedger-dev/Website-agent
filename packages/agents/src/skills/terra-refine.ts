/**
 * Terra — bounded visual refinement of an existing, canonical site.
 *
 * Distinct from `terra-build` (which writes a site from a plan) and from
 * `terra-review` (which only judges pixels): this skill receives the exact
 * source of the canonical build, the exact visual quality review of that
 * build's rendered screenshots, and those same screenshots as images, and
 * returns a complete, strict `BuildOutput` that improves what the review found
 * within the same approved plan.
 *
 * Whether a refinement happens at all, how many there may be, and whether its
 * result is accepted are harness decisions this skill never sees. Its answer is
 * a proposal like any build: staged, validated in isolation, accepted and
 * promoted by the existing lifecycle, or not at all.
 */
import {
  routeToSourcePath,
  type ArtifactRef,
  type BusinessProfile,
  type SitePlan,
  type VisualQualityAssessment,
} from '@statxai/contracts';
import { invokeTerraBuild, TERRA_BUILD_STACK, type TerraBuildOptions } from './terra-build.js';
import type { VisualReviewImage } from './terra-review.js';
import type { ModelRuntime } from '../runtime.js';

const SYSTEM = `You are Terra, a senior frontend engineer and designer refining an existing small-business website.

The site already builds and is live-quality in function. An independent reviewer looked at
screenshots of it — the same screenshots you are shown — and scored its visual quality. Your
job is to make it visibly better where the review found it weak, without breaking anything that
already works.

HOW TO REFINE
- Address the highest-value visual problems first: the ranked refinement priorities, then the
  major issues, then the template-like patterns the reviewer detected. A small number of
  decisive improvements beats many timid ones.
- Preserve functionality: every page still builds, every link still resolves, every form and
  primary action still works.
- Preserve the routes exactly. Every planned route keeps its page file, and you add no new
  route. The plan is fixed — you are changing how the site looks, not what it is.
- Preserve the business facts exactly. Do not add, remove or alter any claim, service, contact
  detail or piece of copy that states something about the business.
- Improve mobile intentionally: design the phone layout, do not merely stack the desktop.
- Do not replace one generic pattern with another. Swapping three equal cards for four equal
  cards, or a centred hero for a differently centred hero, is not a refinement.
- Work from the source you are given. It is the exact canonical source; do not rewrite from
  memory of what a site like this usually looks like.

WHAT YOU RETURN
A complete build output: EVERY file of the site that should exist afterwards, including the
files you did not change, returned unchanged. A file you leave out is removed from the site.

${TERRA_BUILD_STACK}`;

export interface VisualRefinementInput {
  readonly profile: BusinessProfile;
  readonly plan: SitePlan;
  /** Which refinement this is: 1 for the first, 2 for the next. For the model's orientation only. */
  readonly refinementCycle: number;
  /** The exact build being refined, for provenance in the prompt. */
  readonly predecessor: { readonly bindingId: string; readonly sourceCommit: string };
  /** The exact source of that build, as the harness read it from the pinned commit. */
  readonly source: readonly { readonly path: string; readonly contents: string }[];
  /** The exact review that authorised this refinement. */
  readonly review: {
    readonly ref: ArtifactRef;
    readonly screenshotSet: ArtifactRef;
    readonly assessment: VisualQualityAssessment;
  };
  /** The exact frames that review judged, in the order it saw them. */
  readonly frames: readonly VisualReviewImage[];
}

/**
 * One bounded refinement: every turn is one ordinary `terra-refine` invocation
 * through the model runtime, carrying the same images; tools are only those the
 * harness granted, within the same bounds as a build. Returns the final strict
 * `BuildOutput`.
 */
export async function refineSiteVisually(runtime: ModelRuntime, input: VisualRefinementInput, options: TerraBuildOptions = {}) {
  const { assessment } = input.review;
  const routes = input.plan.sitemap.pages.map((p) => `  ${p.route}  →  ${routeToSourcePath(p.route)}`).join('\n');

  return invokeTerraBuild(
    runtime,
    {
      skill: 'terra-refine',
      label: 'terra:refine',
      system: SYSTEM,
      maxTokens: 128_000,
      effort: 'xhigh',
      prompt: `Visual refinement ${input.refinementCycle} of build ${input.predecessor.bindingId} (source commit ${input.predecessor.sourceCommit}).
Triggered by ${input.review.ref.name}@${input.review.ref.version} of ${input.review.screenshotSet.name}@${input.review.screenshotSet.version}.

ROUTES — exactly these, no more and no fewer
${routes}

YOU MAY WRITE ONLY
  app/**  (page files, app/layout.tsx, app/globals.css)
  components/site/**
Never components/ui/**, configuration, lib/ or package.json.

REVIEW SCORES (0-100)
  overall ${assessment.overallScore}
${Object.entries(assessment.scores).map(([dimension, score]) => `  ${dimension} ${score}`).join('\n')}

REVIEW SUMMARY
${assessment.summary}

RANKED REFINEMENT PRIORITIES
${assessment.refinementPriorities.map((p) => `  ${p.rank}. ${p.dimension}${p.route ? ` on ${p.route}` : ' (site-wide)'} — ${p.direction}`).join('\n') || '  (none)'}

ISSUES
${assessment.issues.map((i) => `  ${i.id} [${i.severity} ${i.dimension}] ${i.route} (${i.viewports.join('/')}) — ${i.problem} → ${i.direction}`).join('\n') || '  (none)'}

TEMPLATE-LIKE PATTERNS DETECTED
${assessment.antiPatterns.map((a) => `  ${a.pattern} on ${a.route} (${a.viewports.join('/')})`).join('\n') || '  (none)'}

STRENGTHS TO KEEP
${assessment.strengths.map((s) => `  ${s}`).join('\n') || '  (none)'}

BUSINESS PROFILE
${JSON.stringify(input.profile, null, 2)}

APPROVED PLAN (fixed)
${JSON.stringify(input.plan, null, 2)}

CURRENT SOURCE (${input.source.length} files — the exact canonical build)
${input.source.map((f) => `=== FILE: ${f.path} ===\n${f.contents}`).join('\n\n')}

The ${input.frames.length} images that follow are the screenshots the review judged.`,
      images: input.frames.map((frame, i) => ({
        label: `IMAGE ${i + 1}: ${frame.route} @ ${frame.viewport} — frame ${frame.index} of ${frame.count}, from y=${frame.offsetY}px of a ${frame.sourceHeight}px page`,
        mediaType: 'image/png' as const,
        data: frame.png,
      })),
    },
    options,
  );
}
