/**
 * Choosing how to build, and building.
 *
 * Sol picks the strategy and the harness authorises it; a refusal falls back to
 * `one_shot` rather than ending a delivery, because routing is a preference
 * between two working paths. Each strategy has its own call — decomposition was
 * once entered by throwing a fabricated truncation error, which made "Sol chose
 * to decompose" and "one-shot was tried and did not fit" the same code path and
 * indistinguishable afterwards.
 */
import { HOME_ROUTE, routeToSourcePath, type SitePlan } from '@statxai/contracts';
import { buildAnchor, buildPage, buildSite, routeBuild } from '@statxai/agents';
import { scaffoldSite } from '@statxai/workspace';
import { permittedStrategies, authorizeRoute, type RoutingAuthorization } from '@statxai/policy-engine';
import { developerOverride, executeRoute, type RouteDecisionRecord } from '../routing.js';
import type { FixedContext } from '../run-context.js';

async function recordRoute(
  ctx: FixedContext,
  authorization: RoutingAuthorization,
  proposed: RouteDecisionRecord['proposed'],
  modelFailure: string | null,
): Promise<void> {
  const record: RouteDecisionRecord = {
    strategy: authorization.strategy,
    source: authorization.source,
    refusal: authorization.refusal,
    proposed,
    modelFailure,
    decidedAt: new Date(),
  };
  const { deps, facts } = ctx;
  const ref = await deps.registry.put(facts.projectId, 'route-decision', record);
  await deps.registry.accept(facts.projectId, ref);
  await deps.workspace.materialiseArtifact('decisions/route-decision.json', record);
}

/** Persist an adjudication outcome as a versioned artifact. */
async function decideStrategy(ctx: FixedContext, current: SitePlan): Promise<RoutingAuthorization> {
  const { deps, facts } = ctx;
  const override = developerOverride();
  const permitted = permittedStrategies(current);

  let authorization: RoutingAuthorization;
  let proposed: RouteDecisionRecord['proposed'] = null;
  let modelFailure: string | null = null;

  try {
    const routed = await routeBuild(deps.model, facts.profile, current, {
      pageCount: current.sitemap.pages.length,
      sectionCount: current.sitemap.pages.reduce((n, p) => n + p.sections.length, 0),
      serviceCount: facts.profile.services.length,
      permittedStrategies: permitted,
    });
    deps.track('sol', routed);

    proposed = {
      action: routed.value.action,
      reason: routed.value.reason,
      confidence: routed.value.confidence,
      workstreams: routed.value.workstreams ?? [],
    };
    authorization = authorizeRoute(routed.value, current, override);
  } catch (error) {
    /**
     * Routing is a preference between two working paths, so a model failure
     * must not end a delivery. The run falls back to the documented default
     * and says so; it does not silently behave as though Sol had chosen.
     */
    modelFailure = error instanceof Error ? error.message : String(error);
    authorization = {
      strategy: override ?? 'one_shot',
      source: override ? 'developer-override' : 'fallback',
      refusal: `Sol could not be consulted: ${modelFailure}`,
    };
  }

  await recordRoute(ctx, authorization, proposed, modelFailure);

  deps.say({
    phase: 'build',
    detail:
      authorization.source === 'sol'
        ? `Sol routed to ${authorization.strategy} (confidence ${proposed?.confidence.toFixed(2) ?? '—'}): ${proposed?.reason ?? ''}`
        : `${authorization.strategy} by ${authorization.source} — ${authorization.refusal ?? ''}`,
    level: authorization.source === 'sol' ? 'ok' : 'warn',
  });

  return authorization;
}

/**
 * One call writes the whole site.
 *
 * Coherent by construction: the layout, the brand tokens and every page come
 * out of one response, so the navigation, spacing and component vocabulary
 * cannot drift between pages. It fails when the site does not fit the output
 * ceiling, which is a genuine runtime failure and is handled as one.
 */
async function executeOneShot(ctx: FixedContext, current: SitePlan): Promise<void> {
  const { deps, facts } = ctx;
  deps.say({ phase: 'build', detail: 'Terra is attempting the complete site in one pass' });

  const built = await buildSite(deps.model, facts.profile, current);
  deps.track('terra', built);
  await deps.workspace.writeSiteFiles(built.value.files);

  deps.say({
    phase: 'build',
    detail: `One-shot succeeded: ${built.value.files.length} files (${built.model}, ${(built.ms / 1000).toFixed(1)}s, ${built.outputTokens} out)`,
    level: 'ok',
  });
}

/**
 * An anchor, then the remaining pages in parallel against it.
 *
 * Each call stays well below the output ceiling, at the cost of later pages
 * being built to match a reference rather than written alongside it.
 */
async function executeDecomposed(ctx: FixedContext, current: SitePlan): Promise<void> {
  const { deps, facts } = ctx;
  const anchor = await buildAnchor(deps.model, facts.profile, current);
  deps.track('terra', anchor);
  await deps.workspace.writeSiteFiles(anchor.value.files);

  // The homepage anchors the design system. Selecting by array order once put
  // a nested FAQ page in this role.
  const home = current.sitemap.pages.find((p) => p.route === HOME_ROUTE) ?? current.sitemap.pages[0]!;
  const homeSource = routeToSourcePath(home.route);
  const anchorSource = anchor.value.files.find((f) => f.path === homeSource)?.contents ?? '';
  const layoutSource = anchor.value.files.find((f) => f.path === 'app/layout.tsx')?.contents ?? '';
  deps.say({ phase: 'build', detail: `Anchor: layout + ${homeSource}`, level: 'ok' });

  // Pages are independent given the anchor, and each writes a distinct file,
  // so there is no output conflict to serialise — they can run concurrently.
  const rest = current.sitemap.pages.filter((p) => p.route !== home.route);
  const pages = await Promise.all(
    rest.map((page) => buildPage(deps.model, facts.profile, current, page, anchorSource, layoutSource)),
  );
  for (const page of pages) {
    deps.track('terra', page);
    await deps.workspace.writeSiteFiles(page.value.files);
  }
  deps.say({ phase: 'build', detail: `${rest.length} further pages built in parallel`, level: 'ok' });
}

export async function buildFromPlan(ctx: FixedContext, current: SitePlan): Promise<void> {
  const { deps, facts } = ctx;
  await deps.store.projects.updateOne(
    { _id: facts.projectId },
    { $set: { state: 'building', updatedAt: new Date() } },
  );

  // The scaffold carries the toolchain, the dependency set and the shadcn
  // primitives. Terra writes pages against it and never installs anything, so
  // a build failure is always about the site rather than the toolchain.
  await scaffoldSite(deps.workspace.siteRoot);

  /**
   * The accepted route is executed directly.
   *
   * Decomposition used to be reached by throwing
   * `MalformedModelOutput('forced: output truncated')` so the truncation
   * handler would catch it. That made a deliberate strategy and a runtime
   * failure the same code path, and indistinguishable afterwards. Each
   * strategy now has its own function and its own call.
   */
  const route = await decideStrategy(ctx, current);

  await executeRoute(route, current, {
    oneShot: () => executeOneShot(ctx, current),
    decomposed: async () => {
      deps.say({
        phase: 'build',
        detail: 'Building by decomposition: anchor first, then pages in parallel',
      });
      await executeDecomposed(ctx, current);
    },
    onRecovery: async (error) => {
      deps.say({
        phase: 'build',
        detail: 'One-shot exceeded the output ceiling — recovering by decomposition',
        level: 'warn',
      });
      // A further version of the same artifact, so the trail reads "Sol chose
      // one-shot, then the harness recovered" rather than implying that
      // decomposition had been chosen.
      await recordRoute(ctx, 
        {
          strategy: 'decompose',
          source: 'truncation-recovery',
          refusal: `One-shot exceeded the output ceiling: ${error instanceof Error ? error.message : String(error)}`,
        },
        null,
        null,
      );
    },
  });

  await deps.workspace.commit('Terra: build');
}
