/**
 * Vercel deployment (v1.2 §9).
 *
 * "Publish from a machine-accepted source revision, not from mutable agent
 * workspace state." What is deployed here is the static export produced by the
 * build that the gates and the reviewer both passed — never the working tree,
 * and never a rebuild done at release time.
 */
import { Vercel } from '@vercel/sdk';
import { readExportFiles } from './site-build.js';

export interface DeployResult {
  /** The deployment's own URL, always unique to this release. */
  url: string;
  deploymentId: string;
  /** The deployment this one replaced, recorded so a rollback has a target. */
  rollbackRef: string | null;
  fileCount: number;
  durationMs: number;
  /**
   * Whatever metadata the provider echoed back, when it echoes any.
   *
   * Optional because the create response is a union of views and need not
   * carry it — absent metadata is "no evidence either way", never "the wrong
   * deployment".
   */
  meta?: Record<string, string>;
}

/**
 * One existing deployment, read back by its exact id.
 *
 * The only provider read Phase 5p performs, and only ever for an id an
 * operator supplied by hand. There is deliberately no "find the deployment
 * for this release" search: `GET /v7/deployments` has no metadata filter, so
 * any such search would be a scan whose empty result proves nothing.
 */
export interface ExistingDeployment {
  deploymentId: string;
  url: string;
  /** Deployment metadata as stored at creation — carries our release marker. */
  meta: Record<string, string>;
  /** The Vercel project name, as the provider reports it. */
  project: string | null;
  /** `production`, `staging`, or null for a preview deployment. */
  target: string | null;
}

export class DeploymentUnavailable extends Error {
  constructor(reason: string) {
    super(`Deployment unavailable: ${reason}`);
    this.name = 'DeploymentUnavailable';
  }
}

/**
 * Clear Vercel Authentication on a project.
 *
 * Not exposed by the SDK's typed surface, so this is a direct call to the same
 * REST endpoint the dashboard toggle uses.
 */
async function disableDeploymentProtection(projectName: string, token: string): Promise<void> {
  const team = process.env.VERCEL_TEAM_ID;
  const query = team ? `?teamId=${encodeURIComponent(team)}` : '';

  const response = await fetch(`https://api.vercel.com/v9/projects/${projectName}${query}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ssoProtection: null }),
  });

  if (!response.ok) {
    throw new DeploymentUnavailable(`could not clear deployment protection (${response.status})`);
  }
}

/** Vercel project names are lowercase, alphanumeric and hyphenated, max 100. */
export function toProjectName(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function deploymentConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

/**
 * Deploy the static export.
 *
 * Files are inlined rather than uploaded by hash: a brochure site is around a
 * megabyte, and the extra round trips would buy nothing. Binary assets are
 * base64-encoded because the API's plain-text encoding would corrupt them.
 */
export async function deploySite(
  siteRoot: string,
  projectId: string,
  options: {
    target?: 'production' | 'staging';
    previousDeploymentId?: string | null;
    /**
     * Non-secret provider metadata. Phase 5p puts the release identity here
     * so a deployment can be tied back to the exact release that created it —
     * the evidence an operator reconciles an ambiguous attempt against. It is
     * recovery and audit evidence, never an idempotency key: Vercel offers no
     * idempotency key for deployment creation, and this metadata is not one.
     */
    meta?: Record<string, string>;
  } = {},
): Promise<DeployResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new DeploymentUnavailable('VERCEL_TOKEN is not set');

  const started = Date.now();
  const files = await readExportFiles(siteRoot);
  if (files.length === 0) {
    throw new DeploymentUnavailable('the static export is empty — nothing was built');
  }

  const vercel = new Vercel({ bearerToken: token });

  const created = await vercel.deployments.createDeployment({
    teamId: process.env.VERCEL_TEAM_ID,
    // Framework auto-detection would otherwise 400 on a pre-built export that
    // no longer looks like a Next.js project.
    skipAutoDetectionConfirmation: '1',
    requestBody: {
      name: toProjectName(projectId),
      target: options.target ?? 'production',
      ...(options.meta ? { meta: options.meta } : {}),
      files: [
        ...files.map((f) => ({
          file: f.path,
          data: f.binary ? f.contents.toString('base64') : f.contents.toString('utf8'),
          encoding: f.binary ? ('base64' as const) : ('utf-8' as const),
        })),
        {
          // The export writes "/services" as "services.html". Without clean
          // URLs the host serves that path only at "/services.html", so every
          // link in the site 404s while the homepage looks fine.
          file: 'vercel.json',
          data: JSON.stringify({ cleanUrls: true, trailingSlash: false }),
          encoding: 'utf-8' as const,
        },
      ],
      projectSettings: {
        // Already built. Vercel serves the export as-is.
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: null,
      },
    },
  });

  // The response is a union — the full view and a reduced one for anonymous
  // callers — so the shared fields are read defensively rather than cast.
  const host = 'url' in created && typeof created.url === 'string' ? created.url : '';
  const deploymentId = 'id' in created ? String(created.id) : '';

  if (!host) throw new DeploymentUnavailable('Vercel returned a deployment with no URL');

  // New projects are created with Vercel Authentication enabled, which serves a
  // login page instead of the site. A published business website behind SSO is
  // not published, so protection is cleared on the project after the first
  // deployment creates it.
  await disableDeploymentProtection(toProjectName(projectId), token).catch(() => {
    // Non-fatal: the deployment exists and the URL is real. Surfacing this as a
    // release failure would be worse than a site that needs one manual toggle.
  });

  return {
    url: `https://${host}`,
    deploymentId,
    rollbackRef: options.previousDeploymentId ?? null,
    fileCount: files.length,
    durationMs: Date.now() - started,
    meta: readMeta(created),
  };
}

/**
 * Read one exact deployment back from the provider.
 *
 * Used only by operator-driven adoption (Phase 5p): a human who has found the
 * deployment in the Vercel dashboard supplies its id, and this is what proves
 * the id is real, belongs to the expected project/target, and carries the
 * expected release marker before it is adopted as a release's outcome.
 */
export async function getDeploymentById(deploymentId: string): Promise<ExistingDeployment> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new DeploymentUnavailable('VERCEL_TOKEN is not set');

  const vercel = new Vercel({ bearerToken: token });
  const found = await vercel.deployments.getDeployment({
    idOrUrl: deploymentId,
    teamId: process.env.VERCEL_TEAM_ID,
  });

  // The response is a union of full and reduced views, so every field is read
  // defensively rather than cast — the same discipline `deploySite` uses.
  const id = 'id' in found && found.id != null ? String(found.id) : deploymentId;
  const host = 'url' in found && typeof found.url === 'string' ? found.url : '';
  const project = 'name' in found && typeof found.name === 'string' ? found.name : null;
  const target = 'target' in found && typeof found.target === 'string' ? found.target : null;

  return {
    deploymentId: id,
    url: host.startsWith('http') ? host : `https://${host}`,
    meta: readMeta(found),
    project,
    target,
  };
}

/** Provider metadata, as string pairs, however sparse the response view is. */
function readMeta(response: unknown): Record<string, string> {
  if (typeof response !== 'object' || response === null || !('meta' in response)) return {};
  const meta = (response as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return {};

  const pairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof value === 'string') pairs[key] = value;
  }
  return pairs;
}
