import { describe, expect, it } from 'vitest';
import type { BusinessProfile, SitePlan } from '@statxai/contracts';
import { runGates, type SiteFile } from '../src/index.js';

const base: BusinessProfile = {
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

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harrowgate Joinery</title><meta name="description" content="Joinery.">
<link rel="stylesheet" href="/_next/static/chunks/site.css"></head>
<body><main><h1>Harrowgate Joinery</h1>${body}</main>
<footer>workshop@harrowgatejoinery.co.uk 01423 887 214</footer></body></html>`;

const site = (body: string): SiteFile[] => [
  { path: 'index.html', contents: page(body) },
  { path: '_next/static/chunks/site.css', contents: 'body{font-family:Georgia,serif}@media(min-width:40rem){body{padding:1rem}}' },
];

const claims = (body: string, profile: BusinessProfile = base) =>
  runGates({ files: site(body), profile, plan }).findings.filter((f) => f.gate === 'claims');

describe('claims provenance gate', () => {
  it('catches an invented aftercare undertaking', () => {
    // The exact defect that shipped on a released site in run 4.
    const found = claims('<p>We can come back and ease a door after the first heating season.</p>');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('aftercare');
  });

  it('catches invented free pricing', () => {
    // The equivalent defect from run 5: "Both are free".
    expect(claims('<p>A workshop visit or a home measure. Both are free.</p>').length).toBe(1);
  });

  it('catches an invented guarantee', () => {
    expect(claims('<p>Every commission is guaranteed for ten years.</p>').length).toBe(1);
  });

  it('catches an invented response-time commitment', () => {
    expect(claims('<p>We reply within 24 hours, every time.</p>').length).toBe(1);
  });

  it('allows a claim the profile actually supports', () => {
    const supported: BusinessProfile = {
      ...base,
      differentiators: [...base.differentiators, 'Free no-obligation home measure on every commission'],
    };
    expect(claims('<p>The home measure is free of charge.</p>', supported)).toEqual([]);
  });

  it('allows a guarantee the profile actually states', () => {
    const supported: BusinessProfile = {
      ...base,
      differentiators: [...base.differentiators, 'Ten-year guarantee on all cabinetry'],
    };
    expect(claims('<p>Guaranteed for ten years.</p>', supported)).toEqual([]);
  });

  it('does not fire on ordinary copy', () => {
    expect(
      claims('<p>Fitted wardrobes and boot rooms, drawn and made in our Starbeck workshop.</p>'),
    ).toEqual([]);
  });

  it('detects a claim starting immediately after a heading', () => {
    // Regression: naive text extraction concatenates adjacent elements
    // ("JoineryWe can come back"), which breaks the word boundary at the start
    // of every pattern and silently disables the gate.
    expect(claims('<h2>Nearby</h2><p>We come back and ease a door each winter.</p>').length).toBe(1);
  });

  it('reads rendered text, not markup', () => {
    // A class name like "price-free" must not be mistaken for a pricing claim.
    expect(claims('<p class="costs-nothing price-free">Solid oak cabinetry.</p>')).toEqual([]);
  });

  it('catches a same-working-day response promise', () => {
    // Shipped undetected in run 8: the pattern only matched "same day", so the
    // "working" variant passed the gate and the reviewer said nothing.
    expect(claims('<p>Leave a message and we will reply the same working day.</p>').length).toBe(1);
  });

  it('does not mistake "come back to you" for a return visit', () => {
    // False positive in run 8: this means reply, not revisit. It fired on the
    // wrong sentence while the real commitment beside it went unnoticed.
    const found = claims('<p>Leave a message and we will come back to you shortly.</p>');
    expect(found.filter((f) => f.message.includes('aftercare'))).toEqual([]);
  });

  it('still catches a genuine return-visit undertaking', () => {
    expect(
      claims('<p>We come back and ease a door once the house has been through a winter.</p>').length,
    ).toBe(1);
  });

  it('blocks release, because an unsupported commitment is materially incorrect', () => {
    // P2 was the original call, on the assumption the reviewer would rate these
    // P1. Across three runs it rated one P1 and missed another entirely, so the
    // deterministic check blocks rather than merely reporting.
    const found = claims('<p>Every commission is guaranteed.</p>');
    expect(found[0]?.severity).toBe('P1');
    expect(runGates({ files: site('<p>Every commission is guaranteed.</p>'), profile: base, plan }).passed).toBe(
      false,
    );
  });
});
