import { describe, expect, it } from 'vitest';
import type { BusinessProfile, SitePlan } from '@statxai/contracts';
import { runGates, type SiteFile } from '../src/index.js';

const profile: BusinessProfile = {
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

const plan = {
  sitemap: { pages: [{ route: '/' }, { route: '/contact' }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const page = (body: string, title = 'Harrowgate Joinery') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="Fitted wardrobes in Harrogate.">
<link rel="stylesheet" href="/_next/static/chunks/site.css"></head>
<body><header><nav><a href="/">Home</a> <a href="/contact">Contact</a></nav></header>
<main>${body}</main>
<footer>Harrowgate Joinery — workshop@harrowgatejoinery.co.uk — 01423 887 214</footer></body></html>`;

const CLEAN: SiteFile[] = [
  { path: 'index.html', contents: page('<h1>Harrowgate Joinery</h1><p>Fitted wardrobes.</p>') },
  {
    path: 'contact.html',
    contents: page(
      '<h1>Contact Harrowgate Joinery</h1><form action="/api/enquiry" method="post"><label for="n">Name</label><input id="n" name="n"></form>',
    ),
  },
  { path: '_next/static/chunks/site.css', contents: 'body{margin:0;max-width:70rem}@media(min-width:48rem){body{padding:2rem}}' },
];

const run = (files: SiteFile[]) => runGates({ files, profile, plan });
const gatesHit = (files: SiteFile[]) => new Set(run(files).findings.map((f) => f.gate));

describe('a clean site', () => {
  it('passes every gate', () => {
    const result = run(CLEAN);
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('structure gate', () => {
  it('catches a missing viewport meta tag', () => {
    const broken = CLEAN.map((f) =>
      f.path === 'index.html'
        ? { ...f, contents: f.contents.replace(/<meta name="viewport"[^>]*>/, '') }
        : f,
    );
    expect(gatesHit(broken)).toContain('structure');
    expect(run(broken).passed).toBe(false);
  });

  it('catches a missing lang attribute', () => {
    const broken = CLEAN.map((f) =>
      f.path === 'index.html' ? { ...f, contents: f.contents.replace('<html lang="en">', '<html>') } : f,
    );
    expect(run(broken).findings.some((f) => f.message.includes('lang'))).toBe(true);
  });
});

describe('links gate', () => {
  it('catches an internal link to a page that was never generated', () => {
    const broken = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('href="/contact"', 'href="/about"') },
      ...CLEAN.slice(1),
    ];
    const finding = run(broken).findings.find((f) => f.gate === 'links');
    expect(finding?.severity).toBe('P1');
    expect(finding?.message).toContain('/about');
  });

  it('catches a remote asset that would 404 without an asset pipeline', () => {
    const broken = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('<main>', '<main><img src="https://cdn.example/x.jpg" alt="x">') },
      ...CLEAN.slice(1),
    ];
    expect(run(broken).findings.some((f) => f.message.includes('remote asset'))).toBe(true);
  });
});

describe('placeholder gate', () => {
  it.each([
    ['lorem ipsum dolor sit amet', 'lorem ipsum'],
    ['Call us on 555-123-4567', '555'],
    ['<!-- TODO: real copy -->', 'TODO'],
    ['email us at hello@example.com', 'example.com'],
  ])('catches %s', (injected) => {
    const broken = [{ ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('<main>', `<main><p>${injected}</p>`) }, ...CLEAN.slice(1)];
    const finding = run(broken).findings.find((f) => f.gate === 'placeholders');
    expect(finding?.severity).toBe('P1');
  });
});

describe('secrets gate', () => {
  it('blocks a committed API key at P0', () => {
    const broken = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('</body>', '<script>const k="sk-abcdefghijklmnop123456";</script></body>') },
      ...CLEAN.slice(1),
    ];
    const finding = run(broken).findings.find((f) => f.gate === 'secrets');
    expect(finding?.severity).toBe('P0');
  });
});

describe('accessibility gate', () => {
  it('catches a form input with no label', () => {
    const broken = CLEAN.map((f) =>
      f.path === 'contact.html'
        ? { ...f, contents: f.contents.replace('<label for="n">Name</label>', '') }
        : f,
    );
    const finding = run(broken).findings.find((f) => f.gate === 'accessibility');
    expect(finding?.severity).toBe('P1');
    expect(finding?.message).toContain('no associated label');
  });

  it('does not flag an svg hidden by an ancestor', () => {
    // Regression: the rule originally checked only the <svg> element, so a
    // decorative icon wrapped in an aria-hidden span was reported as a defect.
    const decorative = [
      {
        ...CLEAN[0]!,
        contents: CLEAN[0]!.contents.replace(
          '<main>',
          '<main><span class="mark" aria-hidden="true"><svg viewBox="0 0 8 8"></svg></span>',
        ),
      },
      ...CLEAN.slice(1),
    ];
    expect(run(decorative).findings.filter((f) => f.message.includes('svg'))).toEqual([]);
  });

  it('still flags a bare svg with no accessible name', () => {
    const bare = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('<main>', '<main><svg viewBox="0 0 8 8"></svg>') },
      ...CLEAN.slice(1),
    ];
    expect(run(bare).findings.some((f) => f.message.includes('svg'))).toBe(true);
  });

  it('catches an image with no alt attribute', () => {
    const broken = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('<main>', '<main><img src="logo.svg">') },
      ...CLEAN.slice(1),
      { path: 'logo.svg', contents: '<svg></svg>' },
    ];
    expect(run(broken).findings.some((f) => f.message.includes('no alt attribute'))).toBe(true);
  });
});

describe('business-facts gate', () => {
  it('catches a page that never names the business', () => {
    const broken = CLEAN.map((f) =>
      f.path === 'index.html' ? { ...f, contents: f.contents.replaceAll('Harrowgate Joinery', 'We') } : f,
    );
    const finding = run(broken).findings.find((f) => f.gate === 'business-facts');
    expect(finding?.severity).toBe('P1');
  });

  it('catches a site missing the real phone number', () => {
    const broken = CLEAN.map((f) => ({ ...f, contents: f.contents.replaceAll('01423 887 214', '') }));
    expect(run(broken).findings.some((f) => f.message.includes('contact phone'))).toBe(true);
  });
});

describe('spec-coverage gate', () => {
  it('blocks at P0 when a specified page was never generated', () => {
    const broken = CLEAN.filter((f) => f.path !== 'contact.html');
    const finding = run(broken).findings.find((f) => f.gate === 'spec-coverage');
    expect(finding?.severity).toBe('P0');
    expect(finding?.message).toContain('/contact');
  });
});

describe('responsive gate', () => {
  it('catches a fixed width that overflows a phone viewport', () => {
    const broken = CLEAN.map((f) =>
      f.path === '_next/static/chunks/site.css' ? { ...f, contents: `${f.contents} .wrap{width:960px}` } : f,
    );
    expect(run(broken).findings.some((f) => f.gate === 'responsive')).toBe(true);
  });

  it('does not flag max-width, which is the correct fluid pattern', () => {
    const fine = CLEAN.map((f) =>
      f.path === '_next/static/chunks/site.css' ? { ...f, contents: `${f.contents} .wrap{max-width:960px}` } : f,
    );
    expect(run(fine).findings.filter((f) => f.gate === 'responsive')).toEqual([]);
  });

  it('does not flag a custom property that merely names a width', () => {
    // False positive on a released site: "--page-width: 1200px" is a token, not
    // a width, and the text-level match saw "page-" where it looked for "max-".
    const fine = CLEAN.map((f) =>
      f.path === '_next/static/chunks/site.css' ? { ...f, contents: `:root{--page-width:1200px}${f.contents}` } : f,
    );
    expect(run(fine).findings.filter((f) => f.gate === 'responsive')).toEqual([]);
  });

  it('does not flag a width clamped with min(), which cannot overflow', () => {
    const fine = CLEAN.map((f) =>
      f.path === '_next/static/chunks/site.css'
        ? { ...f, contents: `${f.contents} .wrap{width:min(1200px, calc(100% - 2rem))}` }
        : f,
    );
    expect(run(fine).findings.filter((f) => f.gate === 'responsive')).toEqual([]);
  });
});

describe('severity semantics', () => {
  it('lets non-blocking findings pass the gate run', () => {
    // A P3 heading-order jump is a real finding but must not block release.
    const nitpick = [
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('<p>Fitted wardrobes.</p>', '<h4>Deep</h4>') },
      ...CLEAN.slice(1),
    ];
    const result = run(nitpick);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.severity === 'P2' || f.severity === 'P3')).toBe(true);
    expect(result.passed).toBe(true);
  });
});

/**
 * A real static export, not a hand-written page.
 *
 * Every case below is a finding a live run actually produced. Together they
 * accounted for 62 of 64 blocking findings on a site that was fine, which
 * exhausted the repair budget and forced a re-plan.
 */
describe('a Next.js static export', () => {
  // The chunk graph an export emits: scripts and CSS under a hashed path, none
  // of which any gate parses, plus the framework's own error pages.
  const EXPORT_ASSETS = [
    '_next/static/chunks/09dqlr4_tv3sz.js',
    '_next/static/chunks/turbopack-338y5zywv8pju.js',
    '_next/static/chunks/site.css',
    '_next/static/media/favicon.2vob68tjqpejf.ico',
    'favicon.ico',
    'index.html',
    'contact.html',
  ];

  const withChunks = (body: string, title?: string) =>
    page(body, title).replace(
      '</body>',
      '<script src="/_next/static/chunks/09dqlr4_tv3sz.js" async></script>' +
        '<script src="/_next/static/chunks/turbopack-338y5zywv8pju.js" async></script></body>',
    );

  const EXPORTED: SiteFile[] = [
    { path: 'index.html', contents: withChunks('<h1>Harrowgate Joinery</h1><p>Fitted wardrobes.</p>') },
    { path: 'contact.html', contents: CLEAN[1]!.contents },
    { path: '_next/static/chunks/site.css', contents: CLEAN[2]!.contents },
  ];

  it('does not report the framework chunk graph as missing assets', () => {
    const findings = runGates({ files: EXPORTED, profile, plan, assets: EXPORT_ASSETS }).findings;
    expect(findings.filter((f) => f.gate === 'links')).toEqual([]);
  });

  it('still reports an asset the site itself invented', () => {
    // The point of the exclusion is the framework's own graph, not blanket
    // silence — a model referencing an image it never created must still fail.
    const files: SiteFile[] = [
      { path: 'index.html', contents: withChunks('<h1>Harrowgate Joinery</h1><img src="/images/hero.jpg" alt="Workshop">') },
      ...EXPORTED.slice(1),
    ];
    const findings = runGates({ files, profile, plan, assets: EXPORT_ASSETS }).findings;
    expect(findings.some((f) => f.gate === 'links' && f.location.includes('/images/hero.jpg'))).toBe(true);
  });

  it('does not read React’s inlined flight payload as page copy', () => {
    // The payload uses "$1", "$L2" as reference markers. Stripping tags without
    // removing script bodies left those in the text, and the price pattern read
    // "$1" as an unsupported price — on every page of a site quoting none.
    const flight =
      '<script>self.__next_f.push([1,"3:[\\"$\\",\\"$L1\\",null,{\\"children\\":\\"$2\\"}]"])</script>';
    const files: SiteFile[] = [
      { path: 'index.html', contents: withChunks('<h1>Harrowgate Joinery</h1><p>Fitted wardrobes.</p>').replace('</body>', `${flight}</body>`) },
      ...EXPORTED.slice(1),
    ];

    const findings = runGates({ files, profile, plan, assets: EXPORT_ASSETS }).findings;
    expect(findings.filter((f) => f.gate === 'claims')).toEqual([]);
  });

  it('still reads a price the visible copy actually states', () => {
    const files: SiteFile[] = [
      { path: 'index.html', contents: withChunks('<h1>Harrowgate Joinery</h1><p>Fitted wardrobes from £2,400.</p>') },
      ...EXPORTED.slice(1),
    ];
    const findings = runGates({ files, profile, plan, assets: EXPORT_ASSETS }).findings;
    expect(findings.some((f) => f.gate === 'claims')).toBe(true);
  });

  it('does not judge the framework’s own error pages as the business’s copy', () => {
    // 404.html and _not-found.html are Next's, not Terra's. They have no <main>
    // and no business content, and a repair cannot change them.
    const files: SiteFile[] = [
      ...EXPORTED,
      { path: '404.html', contents: '<!doctype html><html lang="en"><head><title>404</title></head><body><h1>404</h1></body></html>' },
      { path: '_not-found.html', contents: '<!doctype html><html lang="en"><head><title>404</title></head><body><h1>404</h1></body></html>' },
    ];

    const findings = runGates({ files, profile, plan, assets: EXPORT_ASSETS }).findings;
    expect(findings.filter((f) => f.location.startsWith('404') || f.location.startsWith('_not-found'))).toEqual([]);
  });

  it('reports a build that emitted no stylesheet at all', () => {
    // A true positive worth keeping: a layout that drops
    // `import './globals.css'` compiles, exports, and renders as black text on
    // white. This is exactly how the site shipped once.
    const findings = runGates({
      files: EXPORTED.filter((f) => !f.path.endsWith('.css')),
      profile,
      plan,
      assets: EXPORT_ASSETS.filter((p) => !p.endsWith('.css')),
    }).findings;

    expect(findings.some((f) => f.gate === 'spec-coverage' && f.severity === 'P0')).toBe(true);
  });
});
