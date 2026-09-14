/**
 * Semantic markers survive a real `next build` static export.
 *
 * A site written the way the identity brief instructs — IDs as literal strings
 * in page files, some passed as props through a site component — is built for
 * real in the sandbox, and the site-model gate reads the exported HTML. Nothing
 * here is faked: if React, Next or the export dropped or rewrote a
 * `data-statx-*` attribute, this fails.
 *
 * Integration: needs a Docker daemon, and network access for Google Fonts.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactRef, EditableSiteModel, SitePlan } from '@statxai/contracts';
import { siteModelMarkerFindings } from '@statxai/gates';
import { ProjectWorkspace, buildSite, readBuiltFiles, scaffoldSite, type BuildResult } from '@statxai/workspace';
import { modelFromPlan } from '../src/site-model/materialize.js';

const PLAN = {
  strategy: 's',
  valueProposition: 'v',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFFFFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'Trade-signage directness.',
    radius: 'square',
    rationale: 'r',
  },
  sitemap: {
    pages: [
      {
        route: '/',
        title: 'Harrowgate Joinery',
        metaDescription: 'Fitted joinery made in Harrogate.',
        goal: 'g',
        primaryAction: 'call',
        sections: [
          { id: 'hero', heading: 'Fitted joinery, made here', purpose: 'p', layout: 'split-hero', contentBindings: [] },
          { id: 'services', heading: 'What we make & fit', purpose: 'p', layout: 'rule-list', contentBindings: [] },
        ],
      },
      {
        route: '/about',
        title: 'About the workshop',
        metaDescription: 'Two joiners, one workshop.',
        goal: 'g',
        primaryAction: 'call',
        sections: [{ id: 'story', heading: 'Two joiners', purpose: 'p', layout: 'editorial-split', contentBindings: [] }],
      },
    ],
  },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const planRef: ArtifactRef = { name: 'site-plan', version: 1, contentHash: 'a'.repeat(64) };
const model: EditableSiteModel = modelFromPlan({ projectId: 'proj_marker_export', sitePlanRef: planRef, plan: PLAN });
const [home, about] = model.pages as [EditableSiteModel['pages'][0], EditableSiteModel['pages'][0]];

/** The shape the brief asks for: literal IDs in the page file, one section rendered through a component that receives its IDs as props. */
function homePage(): string {
  const [hero, services] = home.sections;
  return `import type { Metadata } from 'next';
import { Section } from '@/components/site/section';

export const metadata: Metadata = { title: ${JSON.stringify(home.fields[0]!.value)}, description: ${JSON.stringify(home.fields[1]!.value)} };

export default function Home() {
  return (
    <main data-statx-page-id="${home.pageId}" className="px-6">
      <section data-statx-section-id="${hero!.sectionId}" className="py-24">
        <h1 data-statx-field-id="${hero!.fields[0]!.fieldId}" className="text-6xl">${String(hero!.fields[0]!.value)}</h1>
        <p>Made and fitted by the same two people.</p>
      </section>
      <Section sectionId="${services!.sectionId}" headingId="${services!.fields[0]!.fieldId}" heading=${JSON.stringify(services!.fields[0]!.value)} />
    </main>
  );
}
`;
}

function aboutPage(): string {
  const [story] = about.sections;
  return `import type { Metadata } from 'next';

export const metadata: Metadata = { title: ${JSON.stringify(about.fields[0]!.value)}, description: ${JSON.stringify(about.fields[1]!.value)} };

export default function About() {
  return (
    <div data-statx-page-id="${about.pageId}">
      <article data-statx-section-id="${story!.sectionId}">
        <h2 data-statx-field-id="${story!.fields[0]!.fieldId}">
          ${String(story!.fields[0]!.value)}
        </h2>
      </article>
    </div>
  );
}
`;
}

const SECTION_COMPONENT = `export function Section(props: { sectionId: string; headingId: string; heading: string }) {
  return (
    <section data-statx-section-id={props.sectionId} className="border-t py-16">
      <h2 data-statx-field-id={props.headingId}>{props.heading}</h2>
      <ul><li>Wardrobes</li></ul>
    </section>
  );
}
`;

let root: string;
let ws: ProjectWorkspace;
let result: BuildResult;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'statxai-marker-export-'));
  ws = await ProjectWorkspace.open('proj_marker_export', join(root, 'workspaces'));
  await scaffoldSite(ws.siteRoot);
  await ws.writeSiteFiles([
    { path: 'app/page.tsx', contents: homePage() },
    { path: 'app/about/page.tsx', contents: aboutPage() },
    { path: 'components/site/section.tsx', contents: SECTION_COMPONENT },
  ]);
  result = await buildSite(ws.siteRoot, { sandboxRoot: join(root, 'sandbox') });
}, 900_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('a real static export', () => {
  it('builds, and keeps every data-statx attribute and exact value — including ones passed through a component and the ampersand in a heading', async () => {
    expect(result.ok, result.output.slice(-2_000)).toBe(true);
    const index = await readFile(join(ws.siteRoot, 'out', 'index.html'), 'utf8');
    expect(index).toContain(`data-statx-page-id="${home.pageId}"`);
    for (const section of home.sections) expect(index).toContain(`data-statx-section-id="${section.sectionId}"`);

    const files = await readBuiltFiles(ws.siteRoot);
    expect(siteModelMarkerFindings(model, files)).toEqual([]);
  });

  it('the same export fails the gate against a model it does not carry', async () => {
    const files = await readBuiltFiles(ws.siteRoot);
    const moved: EditableSiteModel = structuredClone(model);
    moved.pages[0]!.sections.reverse();
    expect(siteModelMarkerFindings(moved, files).map((f) => f.message).join()).toMatch(/out of the model's order/);
    const retitled: EditableSiteModel = structuredClone(model);
    (retitled.pages[1]!.sections[0]!.fields[0] as { value: string }).value = 'Three joiners';
    expect(siteModelMarkerFindings(retitled, files).map((f) => f.message).join()).toMatch(/not the model's "Three joiners"/);
  });
});
