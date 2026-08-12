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
  sitemap: { pages: [{ path: 'index.html' }, { path: 'contact.html' }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const page = (body: string, title = 'Harrowgate Joinery') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="Fitted wardrobes in Harrogate.">
<link rel="stylesheet" href="styles.css"></head>
<body><header><nav><a href="index.html">Home</a> <a href="contact.html">Contact</a></nav></header>
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
  { path: 'styles.css', contents: 'body{margin:0;max-width:70rem}@media(min-width:48rem){body{padding:2rem}}' },
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
      { ...CLEAN[0]!, contents: CLEAN[0]!.contents.replace('contact.html', 'about.html') },
      ...CLEAN.slice(1),
    ];
    const finding = run(broken).findings.find((f) => f.gate === 'links');
    expect(finding?.severity).toBe('P1');
    expect(finding?.message).toContain('about.html');
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
    expect(finding?.message).toContain('contact.html');
  });
});

describe('responsive gate', () => {
  it('catches a fixed width that overflows a phone viewport', () => {
    const broken = CLEAN.map((f) =>
      f.path === 'styles.css' ? { ...f, contents: `${f.contents} .wrap{width:960px}` } : f,
    );
    expect(run(broken).findings.some((f) => f.gate === 'responsive')).toBe(true);
  });

  it('does not flag max-width, which is the correct fluid pattern', () => {
    const fine = CLEAN.map((f) =>
      f.path === 'styles.css' ? { ...f, contents: `${f.contents} .wrap{max-width:960px}` } : f,
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
