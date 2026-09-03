/**
 * Choosing how to build, and building.
 *
 * Sol picks the strategy and the harness authorises it; a refusal falls back to
 * `one_shot` rather than ending a delivery, because routing is a preference
 * between two working paths. Each strategy has its own call — decomposition was
 * once entered by throwing a fabricated truncation error, which made "Sol chose
 * to decompose" and "one-shot was tried and did not fit" the same code path and
 * indistinguishable afterwards.
 *
 * `signal`, threaded optionally through every function here, is Phase 5e's:
 * `JobRunner` may lose lease authority mid-build, and a model call it cannot
 * cancel (`ModelClient` takes no signal today) can still resolve afterward.
 * Every durable write is preceded by `signal?.throwIfAborted()`, so a response
 * that arrives after authority is gone is read, tracked for telemetry, and
 * then discarded rather than persisted. The direct delivery loop never passes
 * a signal, so `signal` is always `undefined` there and every check is a
 * no-op — this changes nothing about the path §2's runProject still uses.
 *
 * Phase 5f split what used to be one function, {@link buildFromPlan}, into a
 * generation half and a publication half:
 *
 *   {@link prepareBuildFromPlan}   route, build, decompose-recover — every
 *                                  model call and the data those calls
 *                                  produce. Writes nothing durable itself.
 *   {@link publishBuildDirectly}   the durable writes that remain
 *                                  batchable-after-the-fact: the site files,
 *                                  the commit.
 *   {@link buildFromPlan}          project-state update, scaffold, prepare,
 *                                  publish — unchanged from before the split,
 *                                  because nothing was removed from it, only
 *                                  factored into the two functions above it
 *                                  now calls.
 *
 * The reason: a job execution (`frontend-backend.ts`) can lose lease authority
 * mid-build, same as the direct path can lose *nothing*, since nothing else
 * can ever hold its lease. A job handler therefore calls only
 * `prepareBuildFromPlan` and stages the result — see that module for why —
 * while `buildFromPlan` keeps doing exactly what it always did, including the
 * publish step, for the one caller (`orchestrator.ts`) that has never needed
 * anything else.
 *
 * Route-decision persistence is the one write that is *not* deferred to
 * publish, and deliberately not batched into {@link BuildCandidate}'s
 * eventual promotion either. Before the fix below, moving it into
 * `publishBuildDirectly` silently changed the direct path's own failure
 * semantics: pre-5f, `route-decision` was durable the moment Sol decided,
 * before Terra was ever asked to build, so a build that failed after routing
 * still left a route decision on record. Deferring it to publish meant a
 * failed build left *nothing* — publish is never reached. `decideStrategy`
 * and `prepareBuildFromPlan` therefore take an optional `onRouteDecision`
 * hook, invoked synchronously at the exact moment each record is decided (the
 * initial one, and — should one-shot truncate — the recovery one), in the
 * same relative position `recordRoute` used to occupy. `buildFromPlan` is the
 * only caller that supplies it, wired straight to the same persistence
 * `publishBuildDirectly` used to do, so the direct path's write timing is
 * restored exactly. `prepareBuildFromPlan` called without it — every job
 * execution — persists nothing at decide-time either, unchanged: the record
 * is still collected into the returned candidate, for whenever 5g promotes
 * it, but nothing reaches the registry before this execution's authority is
 * proven.
 */
import { HOME_ROUTE, routeToSourcePath, type GeneratedFile, type SitePlan } from '@statxai/contracts';
import { buildAnchor, buildPage, buildSite, routeBuild } from '@statxai/agents';
import { scaffoldSite } from '@statxai/workspace';
import { permittedStrategies, authorizeRoute, type RoutingAuthorization } from '@statxai/policy-engine';
import { developerOverride, executeRoute, type RouteDecisionRecord } from '../routing.js';
import type { FixedContext, RunFacts } from '../run-context.js';

/**
 * Everything {@link prepareBuildFromPlan} produced: computed, not yet
 * written. One or two route-decision records (two only when one-shot
 * truncated and recovery decomposed instead — both are kept, in order, so
 * publishing them still reads as "Sol chose one-shot, then the harness
 * recovered" rather than as a single decompose decision that was never
 * actually made) and the final merged set of generated files.
 */
export interface BuildCandidate {
  readonly routeDecisions: readonly RouteDecisionRecord[];
  readonly files: readonly GeneratedFile[];
}

/**
 * What generation needs, and — by construction, not just by convention —
 * nothing more. No `workspace`, `registry` or `store`: `prepareBuildFromPlan`
 * and everything it calls write nothing durable, so they cannot need
 * anything that writes. A full {@link FixedContext} still satisfies this
 * (it only has more fields, not fewer), so `buildFromPlan` passes its own
 * `ctx` straight through unchanged; a job execution can build one of these
 * without ever opening the canonical project workspace at all.
 */
export interface PrepareContext {
  readonly deps: Pick<FixedContext['deps'], 'model' | 'say' | 'track'>;
  readonly facts: Pick<RunFacts, 'profile'>;
}

/** Persist one route-decision record as a versioned artifact. */
async function persistRouteDecision(ctx: FixedContext, record: RouteDecisionRecord): Promise<void> {
  const { deps, facts } = ctx;
  const ref = await deps.registry.put(facts.projectId, 'route-decision', record);
  await deps.registry.accept(facts.projectId, ref);
  await deps.workspace.materialiseArtifact('decisions/route-decision.json', record);
}

/**
 * Fired once for every route-decision record `prepareBuildFromPlan` produces,
 * at the exact moment it is decided — before generation proceeds on it. The
 * direct path supplies {@link persistRouteDecision} here, restoring pre-5f
 * timing exactly; a job execution supplies nothing, so nothing is written.
 */
type RouteDecisionHook = (record: RouteDecisionRecord) => Promise<void>;

/** Decide the strategy. Pure computation — persistence is entirely the caller's choice, via `onRouteDecision`. */
async function decideStrategy(
  ctx: PrepareContext,
  current: SitePlan,
  signal?: AbortSignal,
  onRouteDecision?: RouteDecisionHook,
): Promise<{ authorization: RoutingAuthorization; record: RouteDecisionRecord }> {
  const { deps, facts } = ctx;
  const override = developerOverride();
  const permitted = permittedStrategies(current);

  let authorization: RoutingAuthorization;
  let proposed: RouteDecisionRecord['proposed'] = null;
  let modelFailure: string | null = null;

  signal?.throwIfAborted();

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

  const record: RouteDecisionRecord = {
    strategy: authorization.strategy,
    source: authorization.source,
    refusal: authorization.refusal,
    proposed,
    modelFailure,
    decidedAt: new Date(),
  };
  // Persisted, when the caller wants that at all, before the "routed to X"
  // narration — the same relative order `recordRoute` occupied pre-5f. Sol's
  // call above cannot be cancelled once sent, so this checks again first:
  // today's two callers never combine a real signal with a hook (the direct
  // path passes no signal; a job execution passes no hook), but the primitive
  // itself must not have a write a future caller could reach uncancellably.
  if (onRouteDecision) {
    signal?.throwIfAborted();
    await onRouteDecision(record);
  }

  deps.say({
    phase: 'build',
    detail:
      authorization.source === 'sol'
        ? `Sol routed to ${authorization.strategy} (confidence ${proposed?.confidence.toFixed(2) ?? '—'}): ${proposed?.reason ?? ''}`
        : `${authorization.strategy} by ${authorization.source} — ${authorization.refusal ?? ''}`,
    level: authorization.source === 'sol' ? 'ok' : 'warn',
  });

  return { authorization, record };
}

/**
 * One call writes the whole site.
 *
 * Coherent by construction: the layout, the brand tokens and every page come
 * out of one response, so the navigation, spacing and component vocabulary
 * cannot drift between pages. It fails when the site does not fit the output
 * ceiling, which is a genuine runtime failure and is handled as one.
 */
async function executeOneShot(ctx: PrepareContext, current: SitePlan, signal?: AbortSignal): Promise<GeneratedFile[]> {
  const { deps, facts } = ctx;
  deps.say({ phase: 'build', detail: 'Terra is attempting the complete site in one pass' });

  signal?.throwIfAborted();
  const built = await buildSite(deps.model, facts.profile, current);
  deps.track('terra', built);

  // The call above cannot be cancelled once sent. Authority may have been
  // lost while it was in flight, so the response is tracked for telemetry —
  // it did happen — but the caller checks the signal again before treating
  // this as something to publish.
  signal?.throwIfAborted();

  deps.say({
    phase: 'build',
    detail: `One-shot succeeded: ${built.value.files.length} files (${built.model}, ${(built.ms / 1000).toFixed(1)}s, ${built.outputTokens} out)`,
    level: 'ok',
  });
  return built.value.files;
}

/**
 * An anchor, then the remaining pages in parallel against it.
 *
 * Each call stays well below the output ceiling, at the cost of later pages
 * being built to match a reference rather than written alongside it.
 */
async function executeDecomposed(ctx: PrepareContext, current: SitePlan, signal?: AbortSignal): Promise<GeneratedFile[]> {
  const { deps, facts } = ctx;
  signal?.throwIfAborted();
  const anchor = await buildAnchor(deps.model, facts.profile, current);
  deps.track('terra', anchor);
  signal?.throwIfAborted();

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
  signal?.throwIfAborted();
  const pages = await Promise.all(
    rest.map((page) => buildPage(deps.model, facts.profile, current, page, anchorSource, layoutSource)),
  );
  signal?.throwIfAborted();
  for (const page of pages) deps.track('terra', page);
  deps.say({ phase: 'build', detail: `${rest.length} further pages built in parallel`, level: 'ok' });

  return [...anchor.value.files, ...pages.flatMap((p) => p.value.files)];
}

/**
 * Route, build, and (if one-shot truncates) recover by decomposing — every
 * model call {@link buildFromPlan} makes. Writes nothing durable itself
 * *unless* `onRouteDecision` is supplied, in which case each route-decision
 * record is handed to it the instant it is decided — see the module doc
 * comment for why that one write is not deferred like the others. Every
 * record is always collected into the returned candidate regardless, so a
 * caller that never persists still has them for whenever it does.
 *
 * Callers decide separately whether and how to publish the rest — the
 * generated files: {@link buildFromPlan} always does, immediately; a job
 * execution stages them instead, and only publishes once it has proven — via
 * a guarded transition, not this call — that it still owns the job.
 */
export async function prepareBuildFromPlan(
  ctx: PrepareContext,
  current: SitePlan,
  signal?: AbortSignal,
  onRouteDecision?: RouteDecisionHook,
): Promise<BuildCandidate> {
  const { deps } = ctx;
  const { authorization, record } = await decideStrategy(ctx, current, signal, onRouteDecision);
  const routeDecisions: RouteDecisionRecord[] = [record];
  let files: GeneratedFile[] = [];

  /**
   * The accepted route is executed directly.
   *
   * Decomposition used to be reached by throwing
   * `MalformedModelOutput('forced: output truncated')` so the truncation
   * handler would catch it. That made a deliberate strategy and a runtime
   * failure the same code path, and indistinguishable afterwards. Each
   * strategy now has its own function and its own call.
   */
  await executeRoute(authorization, current, {
    oneShot: async () => {
      files = await executeOneShot(ctx, current, signal);
    },
    decomposed: async () => {
      deps.say({
        phase: 'build',
        detail: 'Building by decomposition: anchor first, then pages in parallel',
      });
      files = await executeDecomposed(ctx, current, signal);
    },
    onRecovery: async (error) => {
      deps.say({
        phase: 'build',
        detail: 'One-shot exceeded the output ceiling — recovering by decomposition',
        level: 'warn',
      });
      // A further record, so the trail reads "Sol chose one-shot, then the
      // harness recovered" rather than implying that decomposition had been
      // chosen. Persisted here too, at the same moment recordRoute used to be
      // called for this exact case, when the caller wants that at all.
      const recovery: RouteDecisionRecord = {
        strategy: 'decompose',
        source: 'truncation-recovery',
        refusal: `One-shot exceeded the output ceiling: ${error instanceof Error ? error.message : String(error)}`,
        proposed: null,
        modelFailure: null,
        decidedAt: new Date(),
      };
      routeDecisions.push(recovery);
      if (onRouteDecision) {
        signal?.throwIfAborted();
        await onRouteDecision(recovery);
      }
    },
  });

  return { routeDecisions, files };
}

/**
 * The durable writes {@link buildFromPlan} still batches until after
 * generating: the site files, then the commit. Route-decision persistence is
 * deliberately *not* here — see the module doc comment — so `candidate
 * .routeDecisions` is not read by this function at all; it already reached
 * the registry via `onRouteDecision`, at decide-time, for any caller that
 * wanted that.
 *
 * This is the *only* place that materialises a candidate's generated files
 * into the canonical project workspace. `buildFromPlan` calls it once,
 * immediately after generating. A job execution never calls it at all until
 * its own guarded `running -> validating` transition has proven it still
 * owns the job — see `job-handlers/frontend-backend.ts`, which stages
 * instead.
 */
export async function publishBuildDirectly(
  candidate: BuildCandidate,
  ctx: FixedContext,
  signal?: AbortSignal,
): Promise<void> {
  const { deps } = ctx;
  signal?.throwIfAborted();
  await deps.workspace.writeSiteFiles(candidate.files);

  signal?.throwIfAborted();
  await deps.workspace.commit('Terra: build');
}

export async function buildFromPlan(ctx: FixedContext, current: SitePlan, signal?: AbortSignal): Promise<void> {
  const { deps, facts } = ctx;
  signal?.throwIfAborted();
  await deps.store.projects.updateOne(
    { _id: facts.projectId },
    { $set: { state: 'building', updatedAt: new Date() } },
  );

  // The scaffold carries the toolchain, the dependency set and the shadcn
  // primitives. Terra writes pages against it and never installs anything, so
  // a build failure is always about the site rather than the toolchain.
  await scaffoldSite(deps.workspace.siteRoot);

  // Restores pre-5f timing exactly: a route decision is durable the moment
  // Sol (or the fallback) decides it, before Terra is ever asked to build —
  // so a build that fails after routing still leaves that decision on record.
  const candidate = await prepareBuildFromPlan(ctx, current, signal, (record) => persistRouteDecision(ctx, record));
  await publishBuildDirectly(candidate, ctx, signal);
}
