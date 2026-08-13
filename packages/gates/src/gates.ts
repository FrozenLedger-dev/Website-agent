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
import {
  routeToOutputPath,
  routeToSourcePath,
  type BusinessProfile,
  type GateFinding,
  type SitePlan,
} from '@statxai/contracts';

export interface SiteFile {
  path: string;
  contents: string;
}

export interface GateContext {
  /** The HTML and CSS of the export — everything a gate parses. */
  files: readonly SiteFile[];
  profile: BusinessProfile;
  plan: SitePlan;
  /**
   * Every path in the export, including the assets no gate parses.
   *
   * Without it, existence checks run against the parsed subset and every
   * `<script src="/_next/…">` the framework emits is reported as a missing
   * asset — 54 blocking findings on a site that was perfectly fine, which
   * exhausted the repair budget and forced a re-plan.
   */
  assets?: readonly string[];
}

type Gate = (ctx: GateContext) => GateFinding[];

/**
 * Pages the framework generates for itself.
 *
 * They are part of a correct export and must ship, but the business never wrote
 * them: judging their content against the business profile reports Next's own
 * boilerplate as an invented claim, on every single run.
 */
const FRAMEWORK_PAGES = new Set(['404.html', '_not-found.html', '_global-error.html']);

/** The pages the site is accountable for — what every gate judges. */
const htmlFiles = (ctx: GateContext) =>
  ctx.files.filter((f) => f.path.endsWith('.html') && !FRAMEWORK_PAGES.has(f.path));

/** What the export actually contains, for existence checks. */
const exportPaths = (ctx: GateContext) =>
  new Set<string>([...ctx.files.map((f) => f.path), ...(ctx.assets ?? [])]);

/**
 * Map an internal href onto the file the static export produced for it.
 *
 * Links are routes ("/services"), the export is files ("services.html"), and
 * assets are absolute ("/_next/static/…/x.css"). Returns null for hrefs that
 * are not the site's to resolve.
 */
export function resolveInternalHref(href: string): string | null {
  const path = href.split('#')[0]!.split('?')[0]!.replace(/^\.\//, '');
  if (path === '') return null;

  // Already a file — an asset, or a link written as one.
  if (/\.[a-z0-9]+$/i.test(path)) return path.replace(/^\//, '');

  if (path === '/') return 'index.html';
  return `${path.replace(/^\//, '').replace(/\/$/, '')}.html`;
}

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
  const existing = exportPaths(ctx);

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

      const target = resolveInternalHref(href);
      if (target === null || existing.has(target)) continue;

      findings.push({
        gate: 'links',
        severity: 'P1',
        location: `${file.path} -> ${href}`,
        message: `Internal link points at "${href}", which exported no page.`,
        acceptanceTest: `The route "${href}" exists in the sitemap and exports to ${target}.`,
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
        // The framework's own chunk graph is the build's to guarantee, and a
        // repair cannot change it — the model does not write these references.
        if (value.startsWith('/_next/')) continue;
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
        const target = value.replace(/^\.\//, '').replace(/^\//, '').split('?')[0]!;
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

    // Script and style bodies are removed, not just their tags. Stripping tags
    // alone leaves the contents behind, and a static export inlines React's
    // flight payload into <body> — which is full of "$1", "$2" markers that the
    // price pattern reads as a price the profile does not support. That fired
    // on every page of a site whose visible copy quoted no prices at all.
    for (const element of body?.querySelectorAll('script, style, template, noscript') ?? []) {
      element.remove();
    }

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

  // Every planned route must have prerendered to a real HTML file. A route that
  // compiles but exports nothing is the failure this catches: the build passes,
  // and the page simply does not exist.
  for (const page of ctx.plan.sitemap.pages) {
    const output = routeToOutputPath(page.route);
    if (!existing.has(output)) {
      findings.push({
        gate: 'spec-coverage',
        severity: 'P0',
        location: routeToSourcePath(page.route),
        message: `Route "${page.route}" (${page.title}) did not export to ${output}.`,
        acceptanceTest: `${output} exists in the static export.`,
      });
    }
  }

  // Tailwind emits a hashed stylesheet under _next/static. No CSS at all means
  // the styling never reached the browser, which is invisible in the source.
  if (!ctx.files.some((f) => f.path.endsWith('.css'))) {
    findings.push({
      gate: 'spec-coverage',
      severity: 'P0',
      location: 'app/globals.css',
      message: 'The build produced no stylesheet, so the site renders unstyled.',
      acceptanceTest: 'The static export contains a CSS file.',
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
    /**
     * Only a bare `width` set to a literal pixel value can overflow.
     *
     * The property name is parsed rather than pattern-matched, because a
     * text-level match flags things that are correct: `--page-width: 1200px`
     * is a custom property, not a width, and `width: min(var(--page-width),
     * 100%)` is the fluid pattern this gate exists to encourage. Both were
     * reported on a site that had no overflow at all.
     */
    const declaration = /(?:^|[;{])\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;}]+)/gi;
    const offenders = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = declaration.exec(file.contents)) !== null) {
      const property = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      if (property !== 'width') continue;

      const literal = /^(\d{3,})px$/.exec(value);
      if (literal && Number(literal[1]) > 480) offenders.add(`width: ${value}`);
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

  }

  /**
   * Asked once of the whole site, not once per file.
   *
   * A production build splits CSS across hashed chunks, and a chunk carrying
   * only base rules legitimately has no media query in it. Per-file this
   * reported a real site as non-responsive by naming a bundler artefact the
   * model does not write and a repair cannot change.
   */
  if (css.length > 0 && !css.some((file) => /@media/.test(file.contents))) {
    findings.push({
      gate: 'responsive',
      severity: 'P2',
      location: 'app/globals.css',
      message: 'The site ships no media queries at all, so the layout cannot adapt to viewport size.',
      acceptanceTest: 'The delivered CSS adapts layout across viewport sizes.',
    });
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
    // Emitted by Tailwind's preflight in every build; none of them is the
    // site's to load.
    'segoe ui symbol', 'noto color emoji', 'noto sans symbols', 'apple symbols',
    'ui-system', 'inherit', 'initial', 'unset', 'revert',
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
      /**
       * Only the first family in a stack has to load.
       *
       * Everything after it is a fallback the browser resolves on its own — that
       * is what a fallback is for. Checking the whole stack reported Tailwind's
       * own preflight defaults ("SFMono-Regular", "Liberation Mono") as fonts
       * the site had failed to load, on every build, forever. The gate exists to
       * catch a brand face that never arrives, and a brand face is written
       * first.
       */
      for (const raw of declaration[1]!.split(',').slice(0, 1)) {
        // Tailwind's preflight nests the stack inside a var() fallback:
        //   font-family: var(--default-font-family, …, "Noto Color Emoji");
        // Splitting on commas leaves the closing paren attached, so quotes are
        // stripped after it rather than before — otherwise the family reads as
        // `Noto Color Emoji")`, which is not a font and is not a valid pattern.
        const family = raw
          .trim()
          .replace(/^var\([^,]*$/, '')
          .replace(/\)+$/, '')
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim();
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
    // Escaped first: a family name is data. An unescaped one containing a
    // bracket throws `Invalid regular expression` out of runGates and takes the
    // whole delivery with it — which is what a stray ")" from Tailwind's
    // preflight did, on every correctly-styled site.
    const slug = escapeRegExp(family).replace(/\s+/g, '[+_\\s-]*');
    const linked = new RegExp(`<link[^>]+href=["'][^"']*${slug}`, 'i').test(html);
    const imported = new RegExp(`@import[^;]*${slug}`, 'i').test(allCss);
    if (inFontFace || linked || imported) continue;

    const mandated = specified.includes(family.toLowerCase());

    findings.push({
      gate: 'typography',
      severity: mandated ? 'P1' : 'P2',
      // Where the fix goes, not where the symptom shows: fonts are declared in
      // the brand tokens. A location no source file matches would scope the
      // repair to the whole site.
      location: 'app/globals.css',
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
  const findings = Object.entries(GATES).flatMap(([name, gate]) => {
    try {
      return gate(ctx);
    } catch (error) {
      /**
       * A gate crash is a platform fault, not a site defect — but it means this
       * check did not run, so the release cannot be certified. Reported as a
       * blocking finding rather than thrown: one broken gate must not take down
       * a delivery that has already been paid for, and it must not be mistaken
       * for a gate that passed.
       */
      return [
        {
          gate: name,
          severity: 'P0' as const,
          location: 'platform',
          message: `The ${name} gate failed to run: ${error instanceof Error ? error.message : String(error)}`,
          acceptanceTest: `The ${name} gate completes against this site.`,
        },
      ];
    }
  });
  return {
    passed: !findings.some((f) => f.severity === 'P0' || f.severity === 'P1'),
    findings,
    gatesRun: Object.keys(GATES),
  };
}
