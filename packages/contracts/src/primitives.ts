/**
 * Shared control-plane primitives.
 *
 * Everything here is referenced by both the job contract and the review
 * contract, so it is deliberately kept free of dependencies on either.
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const ProjectId = z.string().regex(/^proj_[a-z0-9_]+$/, 'expected proj_<slug>');
export const JobId = z.string().regex(/^job_[a-z0-9_]+$/, 'expected job_<slug>');

export type ProjectId = z.infer<typeof ProjectId>;
export type JobId = z.infer<typeof JobId>;

// ---------------------------------------------------------------------------
// Agent tiers and worker roles (v1.2 §3)
// ---------------------------------------------------------------------------

/** Orchestration tier. Maps to a model at run time; not a model name. */
export const AgentTier = z.enum(['sol', 'terra', 'luna']);
export type AgentTier = z.infer<typeof AgentTier>;

/**
 * Terra specialist roles from §3, plus the two non-builder roles the pipeline
 * requires: an independent reviewer and a repair worker.
 *
 * `qa_review` is intentionally a Terra-tier role, not Luna. §7 assigns
 * subjective review to an independent Terra reviewer; §3's heading calls Luna
 * "Review & Repair". The document is ambiguous, so the split is pinned here:
 * Luna repairs, Terra reviews. A cheap model must not hold a judgment seat.
 */
export const WorkerRole = z.enum([
  'business_strategy',
  'ux_information_architecture',
  'brand_ui_system',
  'content_seo',
  'frontend_backend',
  'crm_erp_integration',
  'analytics_deployment',
  'qa_review',
  'repair',
]);
export type WorkerRole = z.infer<typeof WorkerRole>;

/** Which tier is permitted to execute a given role. */
export const ROLE_TIER: Readonly<Record<WorkerRole, AgentTier>> = Object.freeze({
  business_strategy: 'terra',
  ux_information_architecture: 'terra',
  brand_ui_system: 'terra',
  content_seo: 'terra',
  frontend_backend: 'terra',
  crm_erp_integration: 'terra',
  analytics_deployment: 'terra',
  qa_review: 'terra',
  repair: 'luna',
});

/**
 * The roles a worker of this tier may claim. The inverse of {@link ROLE_TIER},
 * computed rather than declared a second time, so the two can never disagree.
 */
export function rolesForTier(tier: AgentTier): WorkerRole[] {
  return (Object.keys(ROLE_TIER) as WorkerRole[]).filter((role) => ROLE_TIER[role] === tier);
}

// ---------------------------------------------------------------------------
// Tools (v1.2 §5 / §9)
// ---------------------------------------------------------------------------

export const ToolId = z.enum([
  'filesystem',
  'git',
  'component_library',
  'browser_preview',
  'test_runner',
  'accessibility_scanner',
  'canonical_business_data',
  'cms_draft',
  'asset_library',
  'crm_schema_metadata',
  'crm_sandbox_api',
  'mapping_store',
  'integration_tests',
  'hosting_release_api',
]);
export type ToolId = z.infer<typeof ToolId>;

// ---------------------------------------------------------------------------
// Autonomy (v1.2 §3)
// ---------------------------------------------------------------------------

export const AutonomyMode = z.enum(['full_autonomous', 'supervised_autonomous', 'human_in_the_loop']);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

// ---------------------------------------------------------------------------
// Artifact references
// ---------------------------------------------------------------------------

/**
 * A *pinned* reference to an artifact version.
 *
 * Appendix B requires accepted artifacts to be immutable inputs to downstream
 * work. An unpinned `artifact://business-profile.json` breaks that: re-running
 * a job after an upstream revision would silently feed it different inputs,
 * making failures irreproducible. The version is therefore mandatory.
 */
export const ArtifactRef = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  /** sha256 of the canonical serialisation, when the content is known. */
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

const ARTIFACT_URI = /^artifact:\/\/([A-Za-z0-9._\-/]+)@(\d+)$/;

export function formatArtifactUri(ref: Pick<ArtifactRef, 'name' | 'version'>): string {
  return `artifact://${ref.name}@${ref.version}`;
}

export function parseArtifactUri(uri: string): { name: string; version: number } {
  const match = ARTIFACT_URI.exec(uri);
  if (!match) {
    throw new Error(`Malformed artifact URI "${uri}"; expected artifact://<name>@<version>`);
  }
  return { name: match[1]!, version: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export const Timestamps = z.object({
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Timestamps = z.infer<typeof Timestamps>;
