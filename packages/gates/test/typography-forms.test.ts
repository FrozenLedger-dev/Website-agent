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
  sitemap: { pages: [{ path: 'index.html' }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const page = (head: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harrowgate Joinery</title><meta name="description" content="Joinery.">
<link rel="stylesheet" href="styles.css">${head}</head>
<body><main><h1>Harrowgate Joinery</h1>${body}</main>
<footer>workshop@harrowgatejoinery.co.uk 01423 887 214</footer></body></html>`;

const site = (head: string, body: string, css: string): SiteFile[] => [
  { path: 'index.html', contents: page(head, body) },
  { path: 'styles.css', contents: `${css}@media(min-width:40rem){body{padding:1rem}}` },
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
