/**
 * The customer editor rig's scripted collaborators — the model skills, a
 * faithful compiler with a Next-style static asset set, the gates and the
 * browser capture — and the call record suites assert on.
 *
 * Imports no module it fakes, so a suite's `vi.mock` factory may load it.
 * Test support only.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { EditableSiteModel, SitePlan } from '@statxai/contracts';
import { exportFromPageFiles, pageFilesForModel } from '../../../orchestrator/test/support/site-model-export.js';

// ---------------------------------------------------------------------------
// Scripted collaborators
// ---------------------------------------------------------------------------

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

const planPage = (route: string, title: string) => ({
  route,
  title,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'call',
  sections: [{ id: 's1', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});

export const PLAN = {
  strategy: 'Local trade credibility',
  valueProposition: 'Fitted joinery.',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'Trade-signage directness.',
    radius: 'square',
    rationale: 'Workwear palette.',
  },
  sitemap: { pages: [planPage('/', 'Home'), planPage('/services', 'Services')] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

export const INTAKE = {
  businessName: 'Harrowgate Joinery',
  industry: 'Joinery',
  location: 'Harrogate',
  audience: 'Homeowners',
  services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }],
  differentiators: ['Two joiners'],
  contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' },
  tone: 'Warm',
  goals: ['Enquiries'],
};

const assessment = (overallScore: number) => ({
  overallScore,
  scores: { composition: overallScore, typography: overallScore, spacingRhythm: overallScore, hierarchy: overallScore, brandDistinctiveness: overallScore, assetQuality: overallScore, conversionClarity: overallScore, mobileQuality: overallScore },
  summary: `overall ${overallScore}`,
  routeReviews: [{ route: '/', viewports: ['desktop', 'mobile'], score: overallScore, summary: 's' }],
  strengths: ['Clear phone'],
  issues: [],
  antiPatterns: [],
  refinementPriorities: [],
});

/** Every page links the site stylesheet and carries generated scripts, as a Next export does. */
export const PAGE_HEAD = '<link rel="stylesheet" href="/_next/static/chunks/site.css"><script src="/_next/static/chunks/app.js"></script>';

/** A 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** The static assets every faithful compile of this rig exports beside the pages. `site.css` carries the build's label, so each build's bytes differ. */
export function staticAssets(label: string): { path: string; contents: string | Buffer }[] {
  return [
    { path: '_next/static/chunks/site.css', contents: `@font-face{font-family:Site;src:url(../media/site.woff2) format("woff2")}body{font-family:Site,serif;background:url(/images/bg.png)}main::before{content:"${label}"}` },
    { path: '_next/static/chunks/app.js', contents: 'document.documentElement.dataset.generated="ran"' },
    { path: '_next/static/media/site.woff2', contents: Buffer.from(`font-${label}`) },
    { path: 'images/bg.png', contents: PNG },
  ];
}

export type EditBehaviour = (n: number, input: Agents.SemanticEditInput) => { files: { path: string; contents: string }[] };

export const rig = {
  calls: { edit: [] as Agents.SemanticEditInput[], capture: 0, refine: 0, approve: 0, adjudicate: 0, deploy: 0 },
  editBehaviour: null as EditBehaviour | null,
  editFailures: new Set<number>(),
  editGate: null as Promise<void> | null,
  reset(): void {
    this.calls = { edit: [], capture: 0, refine: 0, approve: 0, adjudicate: 0, deploy: 0 };
    this.editBehaviour = null;
    this.editFailures = new Set();
    this.editGate = null;
  },
  /** Hold every Terra edit until the returned function is called. */
  gate(): () => void {
    let open!: () => void;
    this.editGate = new Promise<void>((resolve) => (open = resolve));
    return () => {
      this.editGate = null;
      open();
    };
  },
};

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
};
function png(width: number, height: number, seed: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row.fill((seed + (y >> 6)) & 0xff, 1);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export const rigMocks = {
  agents(actual: typeof Agents): typeof Agents {
    return {
      ...actual,
      ModelClient: class {},
      buildSite: async (_r: unknown, _p: unknown, _plan: SitePlan, options: { siteModel: EditableSiteModel }) => ({ value: { files: pageFilesForModel(options.siteModel, PAGE_HEAD), notes: '' }, model: 'terra', ...usage }),
      routeBuild: async () => ({ value: { action: 'one_shot', reason: 'small', confidence: 0.9, workstreams: null }, model: 'sol', ...usage }),
      reviewSite: async () => ({ value: { decision: 'accept', qualityScore: 91, blocking: false, issues: [], summary: 's' }, model: 'terra', ...usage }),
      reviewVisualQuality: async () => ({ value: assessment(90), model: 'terra-vision', invocationId: `vr-${rig.calls.capture}`, skill: 'terra-review', tier: 'terra', ...usage }),
      editSiteSemantically: async (_r: unknown, input: Agents.SemanticEditInput) => {
        rig.calls.edit.push(input);
        const n = rig.calls.edit.length;
        if (rig.editGate) await rig.editGate;
        if (rig.editFailures.has(n)) throw new Error('the model provider failed: secret-provider-detail');
        const value = rig.editBehaviour ? rig.editBehaviour(n, input) : { files: pageFilesForModel(input.model, PAGE_HEAD) };
        return { value: { ...value, notes: 'edited' }, model: 'terra', invocationId: `edit-${n}`, skill: 'terra-edit', tier: 'terra', ...usage };
      },
      refineSiteVisually: async () => {
        rig.calls.refine += 1;
        throw new Error('no visual refinement may run');
      },
      recommendApproval: async () => {
        rig.calls.approve += 1;
        throw new Error('no release judgement may run');
      },
      adjudicate: async () => {
        rig.calls.adjudicate += 1;
        throw new Error('no adjudication may run');
      },
    } as unknown as typeof Agents;
  },

  workspace(actual: typeof Workspace): typeof Workspace {
    return {
      ...actual,
      // A faithful compile: the page files a build wrote, plus the static assets, become its export, with the build's own digest.
      buildSite: async (siteRoot: string) => {
        const pages = await exportFromPageFiles(siteRoot);
        const label = createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 12);
        const files = [...pages, ...staticAssets(label)];
        const outDir = join(siteRoot, 'out');
        await rm(outDir, { recursive: true, force: true });
        for (const file of files) {
          await mkdir(join(outDir, file.path, '..'), { recursive: true });
          await writeFile(join(outDir, file.path), file.contents);
        }
        const exportDigest = actual.exportDigestOf(files.map((f) => ({ path: f.path, sha256: createHash('sha256').update(f.contents).digest('hex') })));
        return { ok: true, durationMs: 5, output: '', outDir, exportDigest };
      },
      readBuiltFiles: async (siteRoot: string) => exportFromPageFiles(siteRoot),
      readExportFiles: async () => [],
      readSourceFiles: async () => [{ path: 'app/page.tsx', contents: 'x' }],
      deploymentConfigured: () => false,
      deploySite: async () => {
        rig.calls.deploy += 1;
        throw new Error('no deployment may run');
      },
      captureInBrowser: async (options: Workspace.BrowserRenderOptions) => {
        rig.calls.capture += 1;
        const subject = { ...options.subject, exportDigest: (await actual.readExportTree(options.exportDir)).exportDigest };
        const captures = options.plan.sitemap.pages.flatMap((p) =>
          actual.BROWSER_VIEWPORTS.map((viewport, i) => ({ route: p.route, viewport, reason: 'captured' as const, page: { width: viewport.width, height: viewport.height }, truncated: false, png: png(viewport.width, viewport.height, rig.calls.capture * 16 + i), width: viewport.width, height: viewport.height, detail: null })),
        );
        return {
          report: {
            subject,
            runtime: { playwright: actual.PLAYWRIGHT_VERSION, image: actual.BROWSER_IMAGE },
            viewports: [...actual.BROWSER_VIEWPORTS],
            status: 'completed' as const,
            renders: captures.map((c) => ({ route: c.route, viewport: c.viewport.name, status: 'rendered' as const, httpStatus: 200, navigationMs: 1, readyMs: 1, findings: [] })),
            omittedRoutes: [],
            passed: true,
            truncated: false,
            durationMs: 1,
            reason: null,
          },
          captures,
          policy: actual.SCREENSHOT_POLICY,
        };
      },
    } as unknown as typeof Workspace;
  },

  gates(actual: typeof Gates): typeof Gates {
    return { ...actual, runGates: () => ({ passed: true, findings: [], gatesRun: ['claims'] }) } as unknown as typeof Gates;
  },
};

