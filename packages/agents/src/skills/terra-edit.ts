/**
 * Terra — implementing one exact semantic edit in an existing, canonical site.
 *
 * Distinct from `terra-build` (which writes a site from a plan), `terra-refine`
 * (which improves presentation from a visual review) and `terra-review` (which
 * only judges): this skill receives the exact source of the canonical build,
 * the exact editable site model that source implements, the exact model it must
 * implement next, and the one bounded patch between them — and returns a
 * complete, strict `BuildOutput` that implements that delta and nothing else.
 *
 * The patch, both models and every semantic ID are the harness's. Whether the
 * edit is authorised, and whether its result is accepted, are harness decisions
 * this skill never sees: its answer is a proposal like any build — staged,
 * validated in isolation against the exact result model, accepted and promoted
 * by the existing lifecycle, or not at all.
 */
import {
  routeToSourcePath,
  type BusinessProfile,
  type EditableSiteModel,
  type SemanticPatch,
  type SitePlan,
} from '@statxai/contracts';
import { invokeTerraBuild, semanticIdentityBrief, TERRA_BUILD_STACK, type TerraBuildOptions } from './terra-build.js';
import type { ModelRuntime } from '../runtime.js';

const SYSTEM = `You are Terra, a senior frontend engineer implementing one exact content or structure
edit in an existing small-business website.

The site already builds and works. Its meaning is described by a harness-owned editable site
model: pages, sections, blocks, fields and asset slots, each with an opaque ID, rendered into the
page as data-statx-* attributes. The site owner made exactly one change to that model. You are
given the model before the change, the model after it, the exact change, and the exact source.

HOW TO EDIT
- Implement the change exactly as the resulting model states it: the new value, the new order,
  the new visibility, the new layout, the added or removed block.
- Change nothing else the model describes. Every other modeled value, section order,
  visibility, title and description is already correct in the source and must stay exactly so.
- Use only the IDs in the resulting model. Never invent, rename, reuse or drop a page, section,
  block, field or asset ID; a removed block's IDs disappear with it and are never used again.
- Preserve the routes exactly: every planned route keeps its page file and you add no route.
- Preserve functionality and the existing design: every page still builds, every link resolves,
  every form and primary action still works. This is an edit, not a redesign.
- Work from the source you are given. It is the exact canonical source; do not rewrite from
  memory of what a site like this usually looks like.

WHAT YOU RETURN
A complete build output: EVERY file of the site that should exist afterwards, including the
files you did not change, returned unchanged. A file you leave out is removed from the site.

${TERRA_BUILD_STACK}`;

export interface SemanticEditInput {
  readonly profile: BusinessProfile;
  readonly plan: SitePlan;
  /** The exact build being edited, for provenance in the prompt. */
  readonly predecessor: { readonly bindingId: string; readonly sourceCommit: string };
  /** The exact source of that build, as the harness read it from the pinned commit. */
  readonly source: readonly { readonly path: string; readonly contents: string }[];
  /** The model the source implements now. */
  readonly baseModel: EditableSiteModel;
  /** The model the result must implement — exactly the base with the patch applied. */
  readonly model: EditableSiteModel;
  /** The one patch between them. */
  readonly patch: SemanticPatch;
}

/**
 * One bounded semantic edit: every turn is one ordinary `terra-edit` invocation
 * through the model runtime; tools are only those the harness granted, within
 * the same bounds as a build. Returns the final strict `BuildOutput`.
 */
export async function editSiteSemantically(runtime: ModelRuntime, input: SemanticEditInput, options: TerraBuildOptions = {}) {
  const routes = input.plan.sitemap.pages.map((p) => `  ${p.route}  →  ${routeToSourcePath(p.route)}`).join('\n');
  const { operation } = input.patch;
  const provenance = input.model.provenance;
  const target = provenance.kind === 'semantic_patch' ? provenance.target : '(unknown)';

  return invokeTerraBuild(
    runtime,
    {
      skill: 'terra-edit',
      label: 'terra:edit',
      system: SYSTEM,
      maxTokens: 128_000,
      effort: 'xhigh',
      prompt: `Semantic edit of build ${input.predecessor.bindingId} (source commit ${input.predecessor.sourceCommit}).
The model changes from ${input.patch.baseModel.name}@${input.patch.baseModel.version} to the result below.

THE CHANGE — exactly one operation, targeting ${target}
${JSON.stringify(operation, null, 2)}

ROUTES — exactly these, no more and no fewer
${routes}

YOU MAY WRITE ONLY
  app/**  (page files, app/layout.tsx, app/globals.css)
  components/site/**
Never components/ui/**, configuration, lib/ or package.json.

BUSINESS PROFILE
${JSON.stringify(input.profile, null, 2)}

APPROVED PLAN (fixed)
${JSON.stringify(input.plan, null, 2)}

EDITABLE SITE MODEL BEFORE THE CHANGE (what the current source implements)
${JSON.stringify(input.baseModel, null, 2)}

EDITABLE SITE MODEL AFTER THE CHANGE (what your result must implement)
${JSON.stringify(input.model, null, 2)}

CURRENT SOURCE (${input.source.length} files — the exact canonical build)
${input.source.map((f) => `=== FILE: ${f.path} ===\n${f.contents}`).join('\n\n')}${semanticIdentityBrief(input.model, 'all')}`,
    },
    options,
  );
}
