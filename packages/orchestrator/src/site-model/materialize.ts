/**
 * Materialising the editable site model from exact planning authority.
 *
 * `modelFromPlan` runs before any code is generated, so every build consumes
 * identity rather than code being reverse-engineered for it afterwards.
 * `reconcileModelWithPlan` is a true replan's rule, stated exactly:
 *
 * - a page survives when the revised plan still has its route; a section
 *   survives when its page survives and the revised plan still has its plan key
 *   on it. Survivors keep their IDs, their blocks, their visibility and their
 *   field IDs; their planned attributes (heading, layout, title, description)
 *   take the revised plan's values, because the plan is the authority a replan
 *   replaces;
 * - anything new gets new identity, and never a retired one;
 * - anything removed is retired with everything it contains, forever.
 *
 * No fuzzy matching: a renamed route is a removed page and a new page.
 * Both functions are pure.
 */
import {
  EDITABLE_SITE_MODEL_SCHEMA_VERSION,
  EditableSiteModel,
  type ArtifactRef,
  type SitePage,
  type SitePlan,
  type SiteSection,
} from '@statxai/contracts';
import { IdentityAllocator, usedIds } from './identity.js';

/** The plan cannot be expressed as a valid model — a colour that is not a colour value, a duplicate plan key. Nothing is built from it. */
export class EditableSiteModelUnconstructible extends Error {
  constructor(detail: string) {
    super(`the editable site model cannot be constructed: ${detail}`);
    this.name = 'EditableSiteModelUnconstructible';
  }
}

function finish(candidate: unknown): EditableSiteModel {
  const parsed = EditableSiteModel.safeParse(candidate);
  if (!parsed.success) {
    throw new EditableSiteModelUnconstructible(parsed.error.issues.map((i) => `${i.path.join('.') || '(model)'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

function design(plan: SitePlan): EditableSiteModel['design'] {
  const { palette, typography, radius, artDirection } = plan.brandSystem;
  return {
    colors: { ...palette },
    typography: { headingFamily: typography.headingFamily, bodyFamily: typography.bodyFamily, baseSize: typography.baseSize, scale: typography.scale },
    radius,
    artDirection,
  };
}

function pagesFor(
  projectId: string,
  plan: SitePlan,
  ids: IdentityAllocator,
  base: EditableSiteModel | null,
): SitePage[] {
  const baseByRoute = new Map((base?.pages ?? []).map((page) => [page.route, page]));
  return plan.sitemap.pages.map((planned) => {
    const survivor = baseByRoute.get(planned.route);
    const pageId = survivor ? ids.keep(survivor.pageId) : ids.derive('pg', projectId, planned.route);
    const baseSections = new Map((survivor?.sections ?? []).map((section) => [section.planKey, section]));
    const keepField = (existing: { fieldId: string } | undefined, parent: string, key: string) =>
      existing ? ids.keep(existing.fieldId) : ids.derive('fld', parent, key);

    const sections: SiteSection[] = planned.sections.map((plannedSection) => {
      const sectionSurvivor = baseSections.get(plannedSection.id);
      const sectionId = sectionSurvivor ? ids.keep(sectionSurvivor.sectionId) : ids.derive('sec', pageId, plannedSection.id);
      const heading = sectionSurvivor?.fields.find((f) => f.key === 'heading');
      for (const block of sectionSurvivor?.blocks ?? []) {
        ids.keep(block.blockId);
        for (const field of block.fields) ids.keep(field.fieldId);
      }
      return {
        sectionId,
        planKey: plannedSection.id,
        layout: plannedSection.layout,
        visibility: sectionSurvivor?.visibility ?? 'visible',
        fields: [{ fieldId: keepField(heading, sectionId, 'heading'), key: 'heading', type: 'text', value: plannedSection.heading }],
        blocks: sectionSurvivor ? structuredClone(sectionSurvivor.blocks) : [],
      };
    });

    const title = survivor?.fields.find((f) => f.key === 'title');
    const description = survivor?.fields.find((f) => f.key === 'description');
    return {
      pageId,
      route: planned.route,
      fields: [
        { fieldId: keepField(title, pageId, 'title'), key: 'title', type: 'text', value: planned.title },
        { fieldId: keepField(description, pageId, 'description'), key: 'description', type: 'text', value: planned.metaDescription },
      ],
      sections,
    };
  });
}

/** The first model of a lineage, from one exact plan. Deterministic: the same plan always yields the same model. */
export function modelFromPlan(input: { readonly projectId: string; readonly sitePlanRef: ArtifactRef; readonly plan: SitePlan }): EditableSiteModel {
  const ids = new IdentityAllocator(input.projectId, { retired: [], minted: 0 });
  const pages = pagesFor(input.projectId, input.plan, ids, null);
  return finish({
    schemaVersion: EDITABLE_SITE_MODEL_SCHEMA_VERSION,
    projectId: input.projectId,
    sitePlan: input.sitePlanRef,
    provenance: { kind: 'site_plan', sitePlan: input.sitePlanRef },
    design: design(input.plan),
    pages,
    assets: [],
    identity: { retired: [], minted: ids.minted },
  });
}

/** The next model of a lineage after a true replan: survivors keep identity, the new get new identity, the removed are retired. */
export function reconcileModelWithPlan(input: {
  readonly base: EditableSiteModel;
  readonly baseRef: ArtifactRef;
  readonly sitePlanRef: ArtifactRef;
  readonly plan: SitePlan;
}): EditableSiteModel {
  const { base } = input;
  const ids = new IdentityAllocator(base.projectId, base.identity);
  const pages = pagesFor(base.projectId, input.plan, ids, base);
  for (const asset of base.assets) ids.keep(asset.assetId);

  const now = usedIds({ pages, assets: base.assets });
  const retiredNow = [...usedIds(base)].filter((id) => !now.has(id));
  return finish({
    schemaVersion: EDITABLE_SITE_MODEL_SCHEMA_VERSION,
    projectId: base.projectId,
    sitePlan: input.sitePlanRef,
    provenance: { kind: 'replan', base: input.baseRef, sitePlan: input.sitePlanRef },
    design: design(input.plan),
    pages,
    assets: structuredClone(base.assets),
    identity: { retired: [...base.identity.retired, ...retiredNow].sort(), minted: ids.minted },
  });
}
