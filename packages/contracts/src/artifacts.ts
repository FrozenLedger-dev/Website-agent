/**
 * Canonical business artifacts (v1.2 §4, "Recommended Artifact Registry").
 *
 * These are the project's source of truth. Every factual claim the generated
 * website makes must trace back to a field here — §7 requires claims to be
 * supported by client-provided information rather than invented, and the
 * content gate enforces it mechanically.
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// business-profile.json
// ---------------------------------------------------------------------------

export const ServiceOffering = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const BusinessProfile = z.object({
  businessName: z.string().min(1),
  industry: z.string().min(1),
  location: z.string().min(1),
  serviceArea: z.string().optional(),
  audience: z.string().min(1),
  services: z.array(ServiceOffering).min(1),
  differentiators: z.array(z.string().min(1)),
  yearsInBusiness: z.number().int().nonnegative().optional(),
  contact: z.object({
    email: z.string().min(1),
    phone: z.string().min(1),
    address: z.string().optional(),
  }),
  tone: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;

/**
 * Minimum bar for a profile to reach Build.
 *
 * §3 tells Sol to flag missing facts for resolution, but Full Autonomous mode
 * has nobody to resolve them — so thin intake would force the model to either
 * invent (failing review permanently) or ship a hollow site. This gate is what
 * makes `intake_insufficient` reachable before any tokens are spent.
 */
export function intakeGaps(profile: BusinessProfile): string[] {
  const gaps: string[] = [];
  if (profile.services.length === 0) gaps.push('no services listed');
  if (profile.differentiators.length === 0) gaps.push('no differentiators listed');
  if (!profile.contact.email.includes('@')) gaps.push('contact email is not an address');
  if (profile.contact.phone.replace(/\D/g, '').length < 7) gaps.push('contact phone is too short to be real');
  if (profile.goals.length === 0) gaps.push('no business goals stated');
  return gaps;
}

// ---------------------------------------------------------------------------
// brand-system.json
// ---------------------------------------------------------------------------

export const BrandSystem = z.object({
  palette: z.object({
    background: z.string().min(1),
    surface: z.string().min(1),
    text: z.string().min(1),
    muted: z.string().min(1),
    accent: z.string().min(1),
    accentText: z.string().min(1),
    /** Hairlines and dividers. Left unspecified, every builder guessed. */
    border: z.string().min(1),
  }),
  typography: z.object({
    headingFamily: z.string().min(1),
    bodyFamily: z.string().min(1),
    baseSize: z.string().min(1),
    scale: z.string().min(1),
  }),
  /**
   * How this specific business should be composed, in a sentence or three.
   *
   * Palette and type alone do not stop every delivery converging on the same
   * page with different words in it — a joinery workshop, a pizzeria and a law
   * firm were all returning a hero, three equal cards and a closing band. This
   * field carries the compositional character: what the first screen does, what
   * structure the page takes, what to lean on when there is no photography.
   */
  artDirection: z.string().min(1),
  /** One radius across the whole site, so the detailing reads as deliberate. */
  radius: z.enum(['square', 'subtle', 'rounded']),
  rationale: z.string().min(1),
});
export type BrandSystem = z.infer<typeof BrandSystem>;

// ---------------------------------------------------------------------------
// sitemap.json + page-spec/*.json
// ---------------------------------------------------------------------------

/**
 * The compositional forms a section can take.
 *
 * The plan used to describe only what a section *said* — heading, purpose,
 * which profile fields it drew from — and left the form to the builder, which
 * had to invent a layout six times a page and defaulted to the cheapest one.
 * Pages came back as a uniform stack of centred text with three equal cards
 * under every heading.
 *
 * Naming the form makes composition a planning decision rather than an
 * improvisation, and makes "no two adjacent sections share a silhouette"
 * something the specification can state and a reader can check.
 *
 * Every archetype is buildable from the scaffold's primitives with no
 * photography, because there is no asset pipeline.
 */
export const SectionLayout = z.enum([
  /** Asymmetric opener: oversized headline hard left, panel carrying the action. */
  'split-hero',
  /** Tight full-bleed accent strip: one line, one action. */
  'accent-band',
  /** Full-bleed dark strip of two to four oversized numerals with small captions. */
  'stat-strip',
  /** Asymmetric card grid with the first card inverted for emphasis. */
  'feature-grid',
  /** Full-width rows divided by thin rules — for lists that are not really cards. */
  'rule-list',
  /** Oversized ordinals down one column, copy beside them. */
  'numbered-steps',
  /** Narrow measure prose against a column of hanging labels and details. */
  'editorial-split',
  /** Key/value rows: hours, coverage, certifications, turnaround. */
  'detail-table',
  /** The accordion primitive, for genuine questions. */
  'faq-accordion',
  /** Form one side, real contact details and address the other. */
  'contact-panel',
  /** Full-bleed dark close with a single action. */
  'closing-cta',
]);
export type SectionLayout = z.infer<typeof SectionLayout>;

export const PageSection = z.object({
  id: z.string().min(1),
  heading: z.string().min(1),
  purpose: z.string().min(1),
  /** The form this section takes. See {@link SectionLayout}. */
  layout: SectionLayout,
  /** Which business-profile fields this section must draw from. */
  contentBindings: z.array(z.string().min(1)),
});

export const PageSpec = z.object({
  /**
   * The page's route, e.g. "/" or "/services".
   *
   * A route rather than a filename: the source path (`app/services/page.tsx`)
   * and the exported path (`services.html`) are both derived from it, so the
   * model never has to know the framework's file conventions and cannot put a
   * page somewhere the build will not find it.
   *
   * Normalised rather than rejected — trailing slashes, missing leading slash
   * and uppercase all mean the obvious thing.
   */
  route: z
    .string()
    .transform((value) => {
      const trimmed = value.trim().toLowerCase().replace(/\/+$/, '');
      if (trimmed === '' || trimmed === '/') return '/';
      return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    })
    .pipe(z.string().regex(/^\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?$/, 'expected a route like "/services"')),
  title: z.string().min(1),
  metaDescription: z.string().min(1),
  goal: z.string().min(1),
  primaryAction: z.string().min(1),
  sections: z.array(PageSection).min(1),
});
export type PageSpec = z.infer<typeof PageSpec>;

/** The site's entry point. Everything else is reachable from it. */
export const HOME_ROUTE = '/';

/** Where a route's source lives in the App Router. */
export function routeToSourcePath(route: string): string {
  return route === HOME_ROUTE ? 'app/page.tsx' : `app${route}/page.tsx`;
}

/**
 * Where a route lands in the static export.
 *
 * Next writes "/services" to "services.html", not "services/index.html", so the
 * gates and the preview server both resolve routes this way.
 */
export function routeToOutputPath(route: string): string {
  return route === HOME_ROUTE ? 'index.html' : `${route.replace(/^\//, '')}.html`;
}

export const Sitemap = z
  .object({
    pages: z.array(PageSpec).min(1),
  })
  /**
   * A site must have a homepage at the root.
   *
   * Without this a planner produced five pages all nested under "about/faq/",
   * leaving the site with no entry point. The build succeeded and the gates
   * then raised ninety blocking findings, so nothing shipped — but a full build
   * had already been paid for. The cheapest place to catch an unbuildable plan
   * is the schema.
   */
  .refine((sitemap) => sitemap.pages.some((page) => page.route === HOME_ROUTE), {
    message: `The sitemap must include a homepage at "${HOME_ROUTE}".`,
  })
  .refine((sitemap) => new Set(sitemap.pages.map((p) => p.route)).size === sitemap.pages.length, {
    message: 'Two pages share the same route.',
  });
export type Sitemap = z.infer<typeof Sitemap>;

// ---------------------------------------------------------------------------
// The plan Sol produces in one pass
// ---------------------------------------------------------------------------

export const SitePlan = z.object({
  strategy: z.string().min(1),
  valueProposition: z.string().min(1),
  brandSystem: BrandSystem,
  sitemap: Sitemap,
  /**
   * Project-level acceptance criteria. §7 forbids accepting "the builder says
   * it is done", and every rejection must cite one of these.
   */
  acceptanceCriteria: z.array(z.string().min(1)).min(3),
});
export type SitePlan = z.infer<typeof SitePlan>;

// ---------------------------------------------------------------------------
// What a builder returns
// ---------------------------------------------------------------------------

export const GeneratedFile = z.object({
  path: z.string().min(1),
  contents: z.string(),
});
export type GeneratedFile = z.infer<typeof GeneratedFile>;

export const BuildOutput = z.object({
  files: z.array(GeneratedFile).min(1),
  notes: z.string(),
});
export type BuildOutput = z.infer<typeof BuildOutput>;

// ---------------------------------------------------------------------------
// test-report.json
// ---------------------------------------------------------------------------

export const GateFinding = z.object({
  gate: z.string().min(1),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  location: z.string().min(1),
  message: z.string().min(1),
  acceptanceTest: z.string().min(1),
});
export type GateFinding = z.infer<typeof GateFinding>;

export const TestReport = z.object({
  passed: z.boolean(),
  ranAt: z.date(),
  findings: z.array(GateFinding),
  gatesRun: z.array(z.string()),
});
export type TestReport = z.infer<typeof TestReport>;

// ---------------------------------------------------------------------------
// deployment-manifest.json
// ---------------------------------------------------------------------------

export const DeploymentManifest = z.object({
  projectId: z.string().min(1),
  commit: z.string().min(1),
  environment: z.enum(['preview', 'production']),
  autonomyMode: z.string().min(1),
  approvedBy: z.string().min(1),
  qualityScore: z.number().int().min(0).max(100),
  checks: z.array(z.string()),
  /** Where the release is live. Null when nothing left the machine. */
  url: z.string().nullable(),
  deploymentId: z.string().nullable(),
  /** The deployment this one superseded — §9's documented rollback target. */
  rollbackRef: z.string().nullable(),
  releasedAt: z.date(),
});
export type DeploymentManifest = z.infer<typeof DeploymentManifest>;
