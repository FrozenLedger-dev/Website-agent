/**
 * Deterministic quality gates (v1.2 §7).
 *
 * "The platform should not accept 'the builder says it is done' as proof of
 * completion." Everything here is objectively checkable from the built files —
 * no model judgement, no browser. Subjective quality is the reviewer's job.
 *
 * A note on scope, since it matters for how results are described to clients:
 * automated accessibility checking catches a minority of WCAG issues. These
 * gates prove that specific automated checks pass, not that a site is
 * accessible or compliant.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import type { BusinessProfile, GateFinding, SitePlan } from '@statxai/contracts';

export interface SiteFile {
  path: string;
  contents: string;
}

export interface GateContext {
  files: readonly SiteFile[];
  profile: BusinessProfile;
  plan: SitePlan;
}

type Gate = (ctx: GateContext) => GateFinding[];

const htmlFiles = (ctx: GateContext) => ctx.files.filter((f) => f.path.endsWith('.html'));

/** True when any ancestor marks the subtree hidden from assistive technology. */
function hiddenByAncestor(element: HTMLElement): boolean {
  let node = element.parentNode as HTMLElement | null;
  while (node && typeof node.getAttribute === 'function') {
    if (node.getAttribute('aria-hidden') === 'true') return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

const structure: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of htmlFiles(ctx)) {
    const root = parse(file.contents, { comment: false });
    const push = (severity: GateFinding['severity'], message: string, test: string) =>
      findings.push({ gate: 'structure', severity, location: file.path, message, acceptanceTest: test });

    if (!/<!doctype html>/i.test(file.contents)) {
      push('P1', 'Missing <!doctype html>.', 'File begins with <!doctype html>.');
    }
    const html = root.querySelector('html');
    if (!html?.getAttribute('lang')) {
      push('P1', 'The <html> element has no lang attribute.', '<html> carries a lang attribute.');
    }
    if (!root.querySelector('meta[charset]')) {
      push('P1', 'Missing <meta charset>.', 'A <meta charset> element is present in <head>.');
    }
    const viewport = root.querySelector('meta[name="viewport"]');
    if (!viewport) {
      push('P1', 'Missing responsive viewport meta tag.', 'A <meta name="viewport"> element is present.');
    }
    const title = root.querySelector('title')?.text.trim();
    if (!title) {
      push('P1', 'Missing or empty <title>.', '<title> is present and non-empty.');
    }
    const description = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim();
    if (!description) {
      push('P2', 'Missing meta description.', 'A non-empty <meta name="description"> is present.');
    }
    if (!root.querySelector('main')) {
      push('P2', 'No <main> landmark.', 'The page has a <main> landmark element.');
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

const headings: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of htmlFiles(ctx)) {
    const root = parse(file.contents, { comment: false });
    const h1s = root.querySelectorAll('h1');

    if (h1s.length === 0) {
      findings.push({
        gate: 'headings',
        severity: 'P1',
        location: file.path,
        message: 'Page has no <h1>.',
        acceptanceTest: 'The page contains exactly one <h1>.',
      });
    } else if (h1s.length > 1) {
      findings.push({
        gate: 'headings',
        severity: 'P2',
        location: file.path,
        message: `Page has ${h1s.length} <h1> elements; there should be exactly one.`,
        acceptanceTest: 'The page contains exactly one <h1>.',
      });
    }

    const levels = root
      .querySelectorAll('h1, h2, h3, h4, h5, h6')
      .map((el) => Number(el.tagName.slice(1)));
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1]!;
      const current = levels[i]!;
      if (current > prev + 1) {
        findings.push({
          gate: 'headings',
          severity: 'P3',
          location: file.path,
          message: `Heading level jumps from h${prev} to h${current}.`,
          acceptanceTest: 'Heading levels increase by at most one at a time.',
        });
        break;
      }
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Links and assets
// ---------------------------------------------------------------------------

const links: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const existing = new Set(ctx.files.map((f) => f.path));

  for (const file of htmlFiles(ctx)) {
    const root = parse(file.contents, { comment: false });

    for (const anchor of root.querySelectorAll('a')) {
      const href = anchor.getAttribute('href')?.trim();
      if (!href) {
        findings.push({
          gate: 'links',
          severity: 'P2',
          location: file.path,
          message: 'Anchor with no href.',
          acceptanceTest: 'Every <a> has an href.',
        });
        continue;
      }
      if (/^(https?:|mailto:|tel:|#)/i.test(href)) continue;

      const target = href.split('#')[0]!.split('?')[0]!.replace(/^\.\//, '');
      if (target === '' || existing.has(target)) continue;

      findings.push({
        gate: 'links',
        severity: 'P1',
        location: `${file.path} -> ${href}`,
        message: `Internal link points at "${target}", which does not exist in the site.`,
        acceptanceTest: `A file named "${target}" exists, or the link is corrected to an existing page.`,
      });
    }

    // Local assets must exist; remote ones would 404 since there is no asset
    // pipeline in this build.
    const refs: [HTMLElement[], string][] = [
      [root.querySelectorAll('link[rel="stylesheet"]'), 'href'],
      [root.querySelectorAll('script[src]'), 'src'],
      [root.querySelectorAll('img'), 'src'],
    ];
    for (const [elements, attribute] of refs) {
      for (const element of elements) {
        const value = element.getAttribute(attribute)?.trim();
        if (!value || value.startsWith('data:')) continue;
        if (/^https?:\/\//i.test(value)) {
          findings.push({
            gate: 'links',
            severity: 'P1',
            location: `${file.path} -> ${value}`,
            message: 'References a remote asset; this build has no asset pipeline, so it will not resolve.',
            acceptanceTest: 'No remote asset URLs remain; visuals use CSS or inline SVG.',
          });
          continue;
        }
        const target = value.replace(/^\.\//, '').split('?')[0]!;
        if (!existing.has(target)) {
          findings.push({
            gate: 'links',
            severity: 'P1',
            location: `${file.path} -> ${value}`,
            message: `References "${target}", which was not generated.`,
            acceptanceTest: `"${target}" exists in the site, or the reference is removed.`,
          });
        }
      }
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Placeholders and unreplaced boilerplate
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: [RegExp, string][] = [
  [/lorem ipsum/i, 'lorem ipsum filler text'],
  [/\bTODO\b|\bFIXME\b|\bTBD\b/, 'a TODO/FIXME/TBD marker'],
  [/example\.(com|org|net)/i, 'an example.com placeholder domain'],
  [/\b\(?555\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, 'a 555 placeholder phone number'],
  [/your (company|business|name here)/i, 'an unreplaced "Your Company" placeholder'],
  [/\[(insert|your|company|placeholder)[^\]]*\]/i, 'a bracketed placeholder'],
  [/xxx-xxx|123-456-7890/i, 'a dummy phone number'],
];

const placeholders: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of ctx.files) {
    for (const [pattern, description] of PLACEHOLDER_PATTERNS) {
      const match = pattern.exec(file.contents);
      if (!match) continue;
      findings.push({
        gate: 'placeholders',
        severity: 'P1',
        location: file.path,
        message: `Contains ${description}: "${match[0]}".`,
        acceptanceTest: `No occurrence of ${description} remains in ${file.path}.`,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Committed secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/, 'an API key'],
  [/(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, 'a hardcoded credential'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
];

const secrets: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of ctx.files) {
    for (const [pattern, description] of SECRET_PATTERNS) {
      if (!pattern.test(file.contents)) continue;
      findings.push({
        gate: 'secrets',
        severity: 'P0',
        location: file.path,
        message: `Appears to contain ${description}.`,
        acceptanceTest: `${file.path} contains no credentials.`,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Automated accessibility checks
// ---------------------------------------------------------------------------

const accessibility: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of htmlFiles(ctx)) {
    const root = parse(file.contents, { comment: false });

    for (const img of root.querySelectorAll('img')) {
      if (img.getAttribute('alt') === undefined) {
        findings.push({
          gate: 'accessibility',
          severity: 'P2',
          location: file.path,
          message: `<img src="${img.getAttribute('src') ?? '?'}"> has no alt attribute.`,
          acceptanceTest: 'Every <img> has an alt attribute (empty if decorative).',
        });
      }
    }

    for (const svg of root.querySelectorAll('svg')) {
      // An ancestor's aria-hidden hides the whole subtree, so checking only the
      // element itself reports decorative icons wrapped in a hidden span as
      // defects. Walk up before concluding anything.
      const labelled =
        svg.getAttribute('aria-label') ??
        svg.getAttribute('aria-hidden') ??
        svg.getAttribute('role') ??
        svg.querySelector('title') ??
        (hiddenByAncestor(svg) ? 'ancestor' : null);
      if (!labelled) {
        findings.push({
          gate: 'accessibility',
          severity: 'P3',
          location: file.path,
          message: 'Inline <svg> has no accessible name and is not marked decorative.',
          acceptanceTest: 'Every inline <svg> has aria-label, a <title>, or aria-hidden="true".',
        });
      }
    }

    // Form controls need a programmatic label.
    for (const control of root.querySelectorAll('input, select, textarea')) {
      const type = control.getAttribute('type');
      if (type === 'hidden' || type === 'submit' || type === 'button') continue;

      const id = control.getAttribute('id');
      const hasLabel =
        (id && root.querySelector(`label[for="${id}"]`)) ??
        control.getAttribute('aria-label') ??
        control.getAttribute('aria-labelledby');

      if (!hasLabel) {
        findings.push({
          gate: 'accessibility',
          severity: 'P1',
          location: file.path,
          message: `<${control.tagName.toLowerCase()}${type ? ` type="${type}"` : ''}> has no associated label.`,
          acceptanceTest: 'Every form control has a <label for>, aria-label, or aria-labelledby.',
        });
      }
    }

    for (const anchor of root.querySelectorAll('a')) {
      const text = anchor.text.trim();
      const labelled = anchor.getAttribute('aria-label') ?? anchor.querySelector('svg, img');
      if (!text && !labelled) {
        findings.push({
          gate: 'accessibility',
          severity: 'P2',
          location: file.path,
          message: 'Link has no discernible text.',
          acceptanceTest: 'Every link has visible text or an aria-label.',
        });
      }
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Business-fact coverage — claims trace to the profile
// ---------------------------------------------------------------------------

const businessFacts: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const { profile } = ctx;

  for (const file of htmlFiles(ctx)) {
    if (!file.contents.toLowerCase().includes(profile.businessName.toLowerCase())) {
      findings.push({
        gate: 'business-facts',
        severity: 'P1',
        location: file.path,
        message: `Page never names the business ("${profile.businessName}").`,
        acceptanceTest: `"${profile.businessName}" appears on ${file.path}.`,
      });
    }
  }

  const all = htmlFiles(ctx).map((f) => f.contents).join('\n');
  const digits = (s: string) => s.replace(/\D/g, '');

  if (!all.includes(profile.contact.email)) {
    findings.push({
      gate: 'business-facts',
      severity: 'P1',
      location: 'site',
      message: `The contact email (${profile.contact.email}) does not appear anywhere on the site.`,
      acceptanceTest: 'The contact email from the business profile appears on the site.',
    });
  }
  if (!digits(all).includes(digits(profile.contact.phone))) {
    findings.push({
      gate: 'business-facts',
      severity: 'P1',
      location: 'site',
      message: `The contact phone (${profile.contact.phone}) does not appear anywhere on the site.`,
      acceptanceTest: 'The contact phone from the business profile appears on the site.',
    });
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Claims provenance
// ---------------------------------------------------------------------------

/**
 * Commitments a website can make that bind the business commercially.
 *
 * This is the platform's most consequential defect class: across two runs the
 * builder invented an aftercare warranty and then free pricing, neither
 * supported by the profile. Both were caught by the reviewer, and in one case a
 * partial repair still shipped the claim on two pages — so relying on the
 * reviewer to notice every time is the bet that already failed once.
 *
 * `support` lists the profile terms that would legitimise the claim. A match
 * only becomes a finding when the profile contains none of them, so a business
 * that genuinely offers free quotes is not flagged for saying so.
 *
 * Reported at P1, which §7's severity table already implies: an unsupported
 * commitment is materially incorrect business information.
 *
 * This started at P2 on the reasoning that the reviewer rates these P1 and
 * retains blocking authority. Three consecutive runs disproved it — the builder
 * invented a warranty, then free pricing, then a same-working-day response
 * promise, and the reviewer rated the first P1 and missed the third entirely.
 * A layer that inconsistent cannot be the only thing standing between a client
 * and a commitment they never authorised, so the deterministic check blocks.
 *
 * The false-positive cost is real and accepted: a blocked release is a repair
 * cycle, while a false negative is a legally binding promise published on a
 * real business's website.
 */
const CLAIM_PATTERNS: { label: string; pattern: RegExp; support: string[] }[] = [
  {
    label: 'a guarantee or warranty',
    pattern: /\b(guarantee[ds]?|guaranteed|warrant(?:y|ies)|warranted)\b/i,
    support: ['guarantee', 'warrant'],
  },
  {
    label: 'a promise or standing commitment',
    pattern: /\b(we promise|our promise|is our promise|standing commitment|we always will)\b/i,
    support: ['promise', 'commitment'],
  },
  {
    label: 'a free-of-charge offer',
    pattern: /\b(free of charge|costs? nothing|both are free|at no cost|no charge)\b/i,
    support: ['free', 'no cost', 'no charge', 'complimentary'],
  },
  {
    label: 'a response-time commitment',
    // "same working day" is the form that shipped undetected when this only
    // matched "same day".
    pattern:
      /\b(same[- ](?:working )?day|next[- ](?:working )?day|within \d+ (?:hours?|days?|working days?)|24[- ]hour|by return)\b/i,
    support: ['same day', 'same working day', 'next day', 'within', 'hour', 'turnaround', 'reply'],
  },
  {
    label: 'an aftercare or return-visit undertaking',
    // "come back to you" means reply, not revisit — excluded, because matching
    // it produced a false finding while the real commitment went unnoticed.
    // The visit sense needs an action or an explicit return-visit phrase.
    pattern:
      /\b(come back (?:out|and|to (?:ease|adjust|fix|check|refit))|return visit|revisit(?: your| the)|after ?care|call us back out|we(?:'ll| will) pop back)\b/i,
    support: ['aftercare', 'return visit', 'revisit', 'maintenance', 'callback'],
  },
  {
    label: 'a price or discount',
    pattern: /(?:£|\$|€)\s?\d|\b\d+% off\b|\bdiscount\b/i,
    support: ['price', 'pricing', '£', '$', '€', 'discount', 'cost'],
  },
];

const claims: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const profileText = JSON.stringify(ctx.profile).toLowerCase();

  for (const file of htmlFiles(ctx)) {
    // Compare against rendered text, not markup: class names and URLs would
    // otherwise trip the price and free-of-charge patterns constantly.
    //
    // Tags are replaced with a space rather than using `.text`, which
    // concatenates adjacent elements — "<h1>Joinery</h1><p>We can…" becomes
    // "JoineryWe can…", and the word boundary at the start of every pattern
    // then fails. That failure is silent: the gate reports nothing and looks
    // like it passed.
    const body = parse(file.contents, { comment: false }).querySelector('body');
    const text = (body?.innerHTML ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    for (const claim of CLAIM_PATTERNS) {
      const match = claim.pattern.exec(text);
      if (!match) continue;
      if (claim.support.some((term) => profileText.includes(term))) continue;

      findings.push({
        gate: 'claims',
        severity: 'P1',
        location: file.path,
        message: `States ${claim.label} ("${match[0].trim()}") with nothing in the business profile to support it.`,
        acceptanceTest: `${file.path} makes no claim of ${claim.label} unless a business-profile field supports it.`,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Specification coverage
// ---------------------------------------------------------------------------

const specCoverage: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const existing = new Set(ctx.files.map((f) => f.path));

  for (const page of ctx.plan.sitemap.pages) {
    if (!existing.has(page.path)) {
      findings.push({
        gate: 'spec-coverage',
        severity: 'P0',
        location: page.path,
        message: `Specified page "${page.path}" (${page.title}) was not generated.`,
        acceptanceTest: `${page.path} exists in the built site.`,
      });
    }
  }

  if (!existing.has('styles.css')) {
    findings.push({
      gate: 'spec-coverage',
      severity: 'P0',
      location: 'styles.css',
      message: 'The shared stylesheet was not generated.',
      acceptanceTest: 'styles.css exists in the built site.',
    });
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Responsive layout heuristics
// ---------------------------------------------------------------------------

const responsive: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const css = ctx.files.filter((f) => f.path.endsWith('.css'));

  for (const file of css) {
    // Fixed widths above a phone viewport are the usual cause of horizontal
    // overflow at 320px. max-width is fine, so the negative lookbehind matters.
    const fixed = /(?<!max-|min-)width:\s*(\d{3,})px/g;
    let match: RegExpExecArray | null;
    const offenders = new Set<string>();
    while ((match = fixed.exec(file.contents)) !== null) {
      if (Number(match[1]) > 480) offenders.add(match[0]);
    }
    for (const offender of offenders) {
      findings.push({
        gate: 'responsive',
        severity: 'P2',
        location: file.path,
        message: `Fixed "${offender}" will overflow a 320px viewport.`,
        acceptanceTest: 'No fixed width above 480px; use max-width or fluid sizing.',
      });
    }

    if (!/@media/.test(file.contents)) {
      findings.push({
        gate: 'responsive',
        severity: 'P2',
        location: file.path,
        message: 'Stylesheet contains no media queries.',
        acceptanceTest: 'The stylesheet adapts layout across viewport sizes.',
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Typography actually delivered
// ---------------------------------------------------------------------------

/** Families a browser can resolve without the page loading anything. */
const SYSTEM_FAMILIES = new Set(
  [
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'hoefler text', 'baskerville', 'palatino', 'optima', 'gill sans', 'lucida grande', 'charter',
    'helvetica neue', 'arial', 'georgia', 'times', 'times new roman', 'cambria',
    'menlo', 'monaco', 'consolas', 'courier', 'courier new', 'tahoma', 'verdana',
    'liberation sans', 'apple color emoji', 'segoe ui emoji', 'noto sans', 'emoji',
  ].map((f) => f.toLowerCase()),
);

/**
 * A font named but never loaded renders as its fallback, so the brand system on
 * paper is not the one a visitor sees. The independent reviewer caught this;
 * it is mechanically checkable, so it belongs here where it costs nothing.
 */
const typography: Gate = (ctx) => {
  const findings: GateFinding[] = [];
  const css = ctx.files.filter((f) => f.path.endsWith('.css'));
  const html = htmlFiles(ctx).map((f) => f.contents).join('\n');
  const allCss = css.map((f) => f.contents).join('\n');

  const declared = new Set<string>();
  for (const file of css) {
    const declarations = file.contents.matchAll(/(?:font-family|--[\w-]*font[\w-]*)\s*:\s*([^;}]+)/gi);
    for (const declaration of declarations) {
      for (const raw of declaration[1]!.split(',')) {
        const family = raw.trim().replace(/^["']|["']$/g, '').trim();
        if (!family || family.startsWith('var(')) continue;
        if (SYSTEM_FAMILIES.has(family.toLowerCase())) continue;
        if (/^\d/.test(family)) continue;
        declared.add(family);
      }
    }
  }

  // Families the plan committed to. When the specification names the rendered
  // typography, failing to load it is a stated acceptance criterion failing —
  // P1 — not a cosmetic slip. The independent reviewer made exactly this
  // distinction on a run where this gate reported P2 and it reported P1.
  const specified = JSON.stringify(ctx.plan.brandSystem?.typography ?? {}).toLowerCase();

  for (const family of declared) {
    const inFontFace = new RegExp(`@font-face[^}]*${escapeRegExp(family)}`, 'is').test(allCss);
    const slug = family.replace(/\s+/g, '[+_\\s-]*');
    const linked = new RegExp(`<link[^>]+href=["'][^"']*${slug}`, 'i').test(html);
    const imported = new RegExp(`@import[^;]*${slug}`, 'i').test(allCss);
    if (inFontFace || linked || imported) continue;

    const mandated = specified.includes(family.toLowerCase());

    findings.push({
      gate: 'typography',
      severity: mandated ? 'P1' : 'P2',
      location: 'styles.css',
      message:
        `Font family "${family}" is specified but never loaded — no @font-face, @import or stylesheet link. ` +
        (mandated
          ? 'The brand system requires it as rendered type, so this fails a stated acceptance criterion.'
          : 'Visitors see the fallback instead.'),
      acceptanceTest: `"${family}" is either loaded by the site, or removed from the font stacks so only available families are named.`,
    });
  }

  return findings;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Form submission actually reaches someone
// ---------------------------------------------------------------------------

/**
 * A `mailto:` form action is unreliable across browsers — the submission can be
 * dropped without the visitor noticing. For a site whose stated goal is
 * capturing enquiries, a silently lost enquiry is a broken conversion path.
 */
const forms: Gate = (ctx) => {
  const findings: GateFinding[] = [];

  for (const file of htmlFiles(ctx)) {
    const root = parse(file.contents, { comment: false });
    for (const form of root.querySelectorAll('form')) {
      const action = form.getAttribute('action')?.trim() ?? '';

      if (action.startsWith('mailto:')) {
        findings.push({
          gate: 'forms',
          severity: 'P2',
          location: `${file.path} form[action="${action}"]`,
          message:
            'Form submits to a mailto: URL. Browser handling is inconsistent, so a completed enquiry can be silently lost.',
          acceptanceTest:
            'The form posts to a real endpoint, or the page provides an equivalent non-form route that cannot silently fail.',
        });
      }

      if (action === '') {
        findings.push({
          gate: 'forms',
          severity: 'P2',
          location: `${file.path} form`,
          message: 'Form has no action attribute, so submission reloads the page and discards the input.',
          acceptanceTest: 'Every form has an action that delivers the submission somewhere.',
        });
      }
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------

export const GATES: Record<string, Gate> = {
  claims,
  typography,
  forms,
  structure,
  headings,
  links,
  placeholders,
  secrets,
  accessibility,
  'business-facts': businessFacts,
  'spec-coverage': specCoverage,
  responsive,
};

export interface GateRun {
  passed: boolean;
  findings: GateFinding[];
  gatesRun: string[];
}

/** Run every gate. `passed` means no blocking (P0/P1) finding remains. */
export function runGates(ctx: GateContext): GateRun {
  const findings = Object.values(GATES).flatMap((gate) => gate(ctx));
  return {
    passed: !findings.some((f) => f.severity === 'P0' || f.severity === 'P1'),
    findings,
    gatesRun: Object.keys(GATES),
  };
}
