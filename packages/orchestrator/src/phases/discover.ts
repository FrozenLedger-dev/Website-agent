/**
 * Reading the brief, and standing the project up.
 *
 * Everything here is deterministic. No model participates: whether a brief is
 * usable is a question about the facts supplied, and asking Sol would mean
 * spending a token to be told what a schema already knows.
 *
 * This phase runs *before* a `RunContext` can exist, and that is not an
 * accident of ordering — it is what produces two of the things a context is
 * made of. Rather than weakening `RunContext` with optional fields so this
 * could share the later phases' signature, it takes what it needs and returns
 * what it made, and `runProject` assembles the context from that.
 *
 * The two refusals below are the only ones. An unusable brief is a client
 * information problem and comes back as a result; a workspace that will not
 * open or a database that will not answer is a platform failure and throws.
 * Collapsing those would report a broken deployment as a customer's incomplete
 * form.
 */
import { BusinessProfile, intakeGaps, type ArtifactRef, type AutonomyMode } from '@statxai/contracts';
import { createBudget, type BudgetLimits, type StateStore } from '@statxai/state';
import { ProjectWorkspace, type ArtifactRegistry } from '@statxai/workspace';
import type { Progress } from '../run-context.js';

export interface DiscoverInput {
  projectId: string;
  /** Whatever the caller supplied. Unvalidated by definition. */
  intake: unknown;
  store: StateStore;
  registry: ArtifactRegistry;
  workspacesRoot: string;
  autonomyMode: AutonomyMode;
  say: Progress;
}

export type DiscoverResult =
  | { ok: false; outcome: 'intake_insufficient' }
  | {
      ok: true;
      /** The canonical parsed profile. Everything downstream reads this. */
      profile: BusinessProfile;
      /**
       * The exact ref `registry.put` returned when `profile` was persisted —
       * threaded through rather than discarded, so a caller that needs to pin
       * this exact version (Phase 5j's job-mode build boundary) never has to
       * re-resolve "latest" and risk a version accepted after discovery ran.
       */
      businessProfileRef: ArtifactRef;
      workspace: ProjectWorkspace;
      /** The ceilings, never the usage. */
      budgetLimits: BudgetLimits;
    };

/**
 * Whether `intake` is usable, and nothing else — no store, no registry, no
 * workspace, no `say`. The pure half of discovery (Phase 4e's guarantee:
 * malformed or insufficient intake has zero startup side effects), pulled
 * out so a second caller (Phase 5k's active-binding preflight, which must
 * run this exact check before deciding whether to skip discovery's own
 * durable side effects) can reuse it rather than re-deriving it and risking
 * drift from what `discoverProject` itself actually enforces.
 */
export type ValidatedIntake =
  | { readonly ok: true; readonly profile: BusinessProfile }
  | { readonly ok: false; readonly reason: string };

export function validateIntake(intake: unknown): ValidatedIntake {
  const parsed = BusinessProfile.safeParse(intake);
  if (!parsed.success) {
    return { ok: false, reason: `Intake rejected: ${parsed.error.issues[0]?.message}` };
  }
  const profile = parsed.data;

  // Thin intake would force the builder to invent facts, which the content gate
  // then rejects forever. Catch it before spending a single token.
  const gaps = intakeGaps(profile);
  if (gaps.length > 0) {
    return { ok: false, reason: `Intake insufficient: ${gaps.join('; ')}` };
  }
  return { ok: true, profile };
}

/**
 * Where {@link discoverProject} materialises the canonical profile in the
 * project workspace — exported so a second writer (Phase 5k's resume-
 * recovery path, re-materialising a bound profile that this invocation
 * never ran discovery for) never has to duplicate the literal path and risk
 * it drifting from the one `discoverProject` actually writes.
 */
export const BUSINESS_PROFILE_ARTIFACT_PATH = 'client/business-profile.json';

/** Write the canonical profile into its one fixed workspace location. */
export async function materialiseBusinessProfileFile(
  workspace: ProjectWorkspace,
  profile: BusinessProfile,
): Promise<void> {
  await workspace.materialiseArtifact(BUSINESS_PROFILE_ARTIFACT_PATH, profile);
}

export async function discoverProject(input: DiscoverInput): Promise<DiscoverResult> {
  const { projectId, store, registry, autonomyMode, say } = input;

  say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });

  const validated = validateIntake(input.intake);
  if (!validated.ok) {
    say({ phase: 'discover', detail: validated.reason, level: 'fail' });
    return { ok: false, outcome: 'intake_insufficient' };
  }
  const { profile } = validated;
  say({ phase: 'discover', detail: `${profile.businessName} — ${profile.services.length} services`, level: 'ok' });

  /**
   * Nothing above this line touches disk or the database.
   *
   * A rejected brief leaves an existing project exactly as it was — no
   * workspace opened, no state deleted, no budget reset. Validating by
   * standing the project up first would mean a malformed retry destroyed the
   * work of the run before it.
   */
  const workspace = await ProjectWorkspace.open(projectId, input.workspacesRoot);

  // The lifecycle record and its budgets start fresh. Artifacts and their
  // lineage counter are deliberately not touched: history outlives the project
  // document, and clearing it would make a second run's artifacts claim to
  // precede the first run's.
  await store.projects.deleteOne({ _id: projectId });
  await store.budgets.deleteOne({ _id: projectId });
  await store.defectBudgets.deleteMany({ projectId });
  await store.projects.insertOne({
    _id: projectId,
    state: 'planning',
    autonomyMode,
    reviewCycle: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await createBudget(store, projectId);

  // The canonical profile, not the raw intake: everything downstream — the
  // planner, the claims gate, the reviewer — measures against what was parsed.
  const profileRef = await registry.put(projectId, 'business-profile', profile);
  await registry.accept(projectId, profileRef);
  await materialiseBusinessProfileFile(workspace, profile);

  const budget = await store.budgets.findOne({ _id: projectId });
  if (!budget) {
    // Created a moment ago, so its absence is a platform fault. Inventing
    // default ceilings here would let a run spend against limits nobody set.
    throw new Error(`Budget for ${projectId} is missing immediately after creation.`);
  }

  return { ok: true, profile, businessProfileRef: profileRef, workspace, budgetLimits: budget.limits };
}
