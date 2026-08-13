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
  sitemap: { pages: [{ route: '/' }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const page = (head: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harrowgate Joinery</title><meta name="description" content="Joinery.">
<link rel="stylesheet" href="/_next/static/chunks/site.css">${head}</head>
<body><main><h1>Harrowgate Joinery</h1>${body}</main>
<footer>workshop@harrowgatejoinery.co.uk 01423 887 214</footer></body></html>`;

const site = (head: string, body: string, css: string): SiteFile[] => [
  { path: 'index.html', contents: page(head, body) },
  { path: '_next/static/chunks/site.css', contents: `${css}@media(min-width:40rem){body{padding:1rem}}` },
];

const findings = (files: SiteFile[], gate: string) =>
  runGates({ files, profile, plan }).findings.filter((f) => f.gate === gate);

describe('typography gate', () => {
  it('catches a webfont that is named but never loaded', () => {
    // Caught by the independent reviewer on a real run; the brand system on
    // paper was not the one visitors would actually see.
    const files = site('', '<p>Copy.</p>', 'body{font-family:"Source Sans 3",Georgia,serif}');
    const [finding] = findings(files, 'typography');
    expect(finding?.severity).toBe('P2');
    expect(finding?.message).toContain('Source Sans 3');
  });

  it('accepts a font loaded via @font-face', () => {
    const files = site(
      '',
      '<p>Copy.</p>',
      '@font-face{font-family:"Bitter";src:url(bitter.woff2)}body{font-family:"Bitter",Georgia,serif}',
    );
    expect(findings(files, 'typography')).toEqual([]);
  });

  it('accepts a font loaded via a stylesheet link', () => {
    const files = site(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3">',
      '<p>Copy.</p>',
      'body{font-family:"Source Sans 3",Georgia,serif}',
    );
    expect(findings(files, 'typography')).toEqual([]);
  });

  it('blocks when the plan mandates the font as rendered type', () => {
    // The independent reviewer rated this P1 where the gate said P2, and it was
    // right: when the brand system specifies the typography, an unloaded family
    // is a stated acceptance criterion failing, not a cosmetic slip.
    const mandated = {
      ...plan,
      brandSystem: { typography: { headingFamily: '"Fraunces", Georgia, serif' } },
    } as unknown as SitePlan;

    const files = site('', '<p>Copy.</p>', 'h1{font-family:"Fraunces",Georgia,serif}');
    const found = runGates({ files, profile, plan: mandated }).findings.filter((f) => f.gate === 'typography');
    expect(found[0]?.severity).toBe('P1');
    expect(runGates({ files, profile, plan: mandated }).passed).toBe(false);
  });

  it('stays advisory when the plan never specified the font', () => {
    const files = site('', '<p>Copy.</p>', 'h1{font-family:"Fraunces",Georgia,serif}');
    const found = runGates({ files, profile, plan }).findings.filter((f) => f.gate === 'typography');
    expect(found[0]?.severity).toBe('P2');
  });

  it('does not flag pure system stacks', () => {
    const files = site('', '<p>Copy.</p>', 'body{font-family:system-ui,-apple-system,"Segoe UI",Georgia,serif}');
    expect(findings(files, 'typography')).toEqual([]);
  });

  it('reads families out of custom properties too', () => {
    const files = site('', '<p>Copy.</p>', ':root{--font-heading:"Bitter",Georgia,serif}');
    expect(findings(files, 'typography').length).toBe(1);
  });
});

describe('forms gate', () => {
  it('catches a mailto: form action', () => {
    const files = site(
      '',
      '<form action="mailto:workshop@harrowgatejoinery.co.uk"><label for="n">Name</label><input id="n"></form>',
      'body{font-family:Georgia,serif}',
    );
    const [finding] = findings(files, 'forms');
    expect(finding?.severity).toBe('P2');
    expect(finding?.message).toContain('silently lost');
  });

  it('catches a form with no action', () => {
    const files = site('', '<form><label for="n">Name</label><input id="n"></form>', 'body{font-family:Georgia,serif}');
    expect(findings(files, 'forms').some((f) => f.message.includes('no action'))).toBe(true);
  });

  it('accepts a form posting to a real endpoint', () => {
    const files = site(
      '',
      '<form action="/api/enquiry" method="post"><label for="n">Name</label><input id="n"></form>',
      'body{font-family:Georgia,serif}',
    );
    expect(findings(files, 'forms')).toEqual([]);
  });
});

/**
 * Tailwind's own preflight, verbatim.
 *
 * Both cases fired on a real export. The first crashed `runGates` outright,
 * which would have taken the whole delivery with it — and could only happen on
 * a site that had *correctly* shipped a stylesheet.
 */
describe('typography against a real Tailwind build', () => {
  const PREFLIGHT =
    ':root{--default-font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";' +
    '--default-mono-font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}' +
    'body{font-family:var(--default-font-family);margin:0;max-width:70rem}@media(min-width:48rem){body{padding:2rem}}';

  const site = (css: string): SiteFile[] => [
    {
      path: 'index.html',
      contents:
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Harrowgate Joinery</title><meta name="description" content="Fitted wardrobes.">' +
        '<link rel="stylesheet" href="/_next/static/chunks/site.css"></head>' +
        '<body><main><h1>Harrowgate Joinery</h1><p>Fitted wardrobes in Harrogate.</p></main></body></html>',
    },
    { path: '_next/static/chunks/site.css', contents: css },
  ];

  it('does not crash on a family name carrying a stray bracket', () => {
    // `"Noto Color Emoji")` — the closing paren of the var() fallback list rides
    // along when the stack is split on commas. Interpolated into a RegExp it
    // throws `Invalid regular expression: Unmatched ')'`.
    expect(() => runGates({ files: site(PREFLIGHT), profile, plan })).not.toThrow();
  });

  it('does not report the framework’s fallback fonts as unloaded', () => {
    // Only the first family in a stack has to load; the rest are fallbacks, and
    // reporting them flagged Tailwind's defaults on every build forever.
    const found = runGates({ files: site(PREFLIGHT), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toEqual([]);
  });

  it('still reports a brand face that never loads', () => {
    const css = `${PREFLIGHT}h1{font-family:"Cormorant Garamond",Georgia,serif}`;
    const found = runGates({ files: site(css), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('Cormorant Garamond');
  });

  it('accepts a brand face the site actually loads', () => {
    const css =
      `${PREFLIGHT}@font-face{font-family:"Cormorant Garamond";src:url(/fonts/cg.woff2) format("woff2")}` +
      'h1{font-family:"Cormorant Garamond",Georgia,serif}';
    const found = runGates({ files: site(css), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toEqual([]);
  });
});

describe('a gate that throws', () => {
  it('blocks the release instead of ending the run', () => {
    // A crash means the check did not run, so the site cannot be certified —
    // but one broken gate must not take down a delivery already paid for.
    const result = runGates({
      files: [{ path: 'index.html', contents: '<html><body><main><h1>x</h1></main></body></html>' }],
      profile,
      plan: {} as unknown as SitePlan,
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.location === 'platform' && f.severity === 'P0')).toBe(true);
  });
});

/**
 * Tailwind's own preflight, verbatim.
 *
 * Both cases fired on a real export. The first crashed `runGates` outright,
 * which would have taken the whole delivery with it — and could only happen on a
 * site that had *correctly* shipped a stylesheet.
 */
describe('typography against a real Tailwind build', () => {
  const PREFLIGHT =
    ':root{--default-font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";' +
    '--default-mono-font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}' +
    'body{font-family:var(--default-font-family);margin:0;max-width:70rem}@media(min-width:48rem){body{padding:2rem}}';

  const site = (css: string): SiteFile[] => [
    {
      path: 'index.html',
      contents:
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Harrowgate Joinery</title><meta name="description" content="Fitted wardrobes.">' +
        '<link rel="stylesheet" href="/_next/static/chunks/site.css"></head>' +
        '<body><main><h1>Harrowgate Joinery</h1><p>Fitted wardrobes in Harrogate.</p></main></body></html>',
    },
    { path: '_next/static/chunks/site.css', contents: css },
  ];

  it('does not crash on a family name carrying a stray bracket', () => {
    // Splitting the stack on commas leaves the var() list's closing paren
    // attached to the last family: `Noto Color Emoji")`. Interpolated into a
    // RegExp that throws `Invalid regular expression: Unmatched ')'`.
    expect(() => runGates({ files: site(PREFLIGHT), profile, plan })).not.toThrow();
  });

  it('does not report the framework’s fallback fonts as unloaded', () => {
    const found = runGates({ files: site(PREFLIGHT), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toEqual([]);
  });

  it('still reports a brand face that never loads', () => {
    // First in the stack, so it is what a visitor is meant to see.
    const css = `${PREFLIGHT}h1{font-family:"Cormorant Garamond",Georgia,serif}`;
    const found = runGates({ files: site(css), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('Cormorant Garamond');
  });

  it('accepts a brand face the site actually loads', () => {
    const css =
      `${PREFLIGHT}@font-face{font-family:"Cormorant Garamond";src:url(/fonts/cg.woff2) format("woff2")}` +
      'h1{font-family:"Cormorant Garamond",Georgia,serif}';
    const found = runGates({ files: site(css), profile, plan }).findings.filter(
      (f) => f.gate === 'typography',
    );
    expect(found).toEqual([]);
  });
});

describe('a gate that throws', () => {
  it('blocks the release instead of ending the run', () => {
    // A crash means the check did not run, so the site cannot be certified —
    // but one broken gate must not take down a delivery already paid for.
    const result = runGates({
      files: [{ path: 'index.html', contents: '<html><body><main><h1>x</h1></main></body></html>' }],
      profile,
      // No sitemap: spec-coverage dereferences it and throws.
      plan: {} as unknown as SitePlan,
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.location === 'platform' && f.severity === 'P0')).toBe(true);
  });
});
