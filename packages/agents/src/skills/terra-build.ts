/**
 * Terra — one-shot website build (v1.2 §3, "One-Shot First").
 *
 * Attempts the complete site in a single pass. Specialisation happens only if
 * validation fails, so this prompt carries every constraint the deterministic
 * gates will later check — a builder that cannot see the bar cannot clear it.
 */
import { BuildOutput, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Terra, a senior frontend engineer building a complete small-business website.

Output hand-written static HTML and CSS. No build step, no framework, no JavaScript
frameworks. A small amount of vanilla JavaScript is fine only where it genuinely improves
the experience (for example a mobile nav toggle), and the site must work fully without it.

STRUCTURE
- One HTML file per page in the sitemap, at exactly the path given in the page spec.
- One shared stylesheet at "styles.css", linked by every page.
- Every page: <!doctype html>, <html lang="en">, <meta charset>, <meta name="viewport"
  content="width=device-width, initial-scale=1">, a <title>, and a <meta name="description">.
- Shared header with navigation and shared footer on every page, markup identical between
  pages so they read as one site.
- Use semantic landmarks: <header>, <nav>, <main>, <footer>. Exactly one <h1> per page.
  Do not skip heading levels.

CONTENT
- Every factual claim must trace to the business profile. Do not invent testimonials,
  client names, awards, certifications, statistics, prices, or years in business.
- No placeholder text of any kind. No lorem ipsum, no "Your Company Here", no TODO, no
  example.com, no 555 phone numbers. Use the real contact details from the profile.
- Write real copy in the tone the profile specifies. Every section should say something
  specific to this business that could not be copy-pasted to a competitor.

IMAGES
- This build has no asset pipeline, so do not reference any external image files or remote
  URLs — they would 404. Create visual interest with CSS (gradients, shapes, spacing,
  type) and inline SVG you author yourself. Any <img> or <svg> you do include needs an
  alt attribute or role/aria-label.

ACCESSIBILITY AND RESPONSIVENESS
- Every form input needs an associated <label for="...">. Every link needs discernible text.
- Colour contrast must be legible against the brand palette.
- The layout must work from 320px upward with no horizontal overflow. Use fluid widths,
  max-width, and flex/grid wrapping rather than fixed pixel widths on containers.

LINKS
- Internal links may only point at pages that exist in the sitemap. Relative paths only.`;

export async function buildSite(client: ModelClient, profile: BusinessProfile, plan: SitePlan) {
  return client.call({
    tier: 'terra',
    label: 'terra:build',
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 128_000,
    effort: 'xhigh',
    prompt: `Build this website completely. Return every file.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

APPROVED PLAN
${JSON.stringify(plan, null, 2)}`,
  });
}

/**
 * Decomposition step one: the design anchor.
 *
 * Builds the shared stylesheet and the first page together, so the stylesheet
 * is written against real markup rather than in the abstract. Every subsequent
 * page is then built against this anchor, which is what keeps the design system
 * consistent across separately-generated pages.
 */
export async function buildAnchor(
  client: ModelClient,
  profile: BusinessProfile,
  plan: SitePlan,
) {
  const anchor = plan.sitemap.pages[0]!;
  return client.call({
    tier: 'terra',
    label: 'terra:build:anchor',
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 48_000,
    effort: 'xhigh',
    prompt: `Build exactly two files: the shared stylesheet "styles.css" and the first page.

This establishes the design system for the whole site. Later pages will be built to match
it exactly, so the header, footer and navigation markup you write here is the pattern.
The navigation must link to every page in the sitemap.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

BRAND SYSTEM
${JSON.stringify(plan.brandSystem, null, 2)}

FULL SITEMAP (for navigation links)
${JSON.stringify(plan.sitemap.pages.map((p) => ({ path: p.path, title: p.title })), null, 2)}

PAGE TO BUILD
${JSON.stringify(anchor, null, 2)}`,
  });
}

/**
 * Decomposition step two: one page, built against the anchor.
 *
 * The anchor page and stylesheet are supplied as the pattern to match. This is
 * the smallest unit that still produces a coherent site, and it keeps each call
 * far below the output ceiling that defeats the whole-site attempt.
 */
export async function buildPage(
  client: ModelClient,
  profile: BusinessProfile,
  plan: SitePlan,
  page: SitePlan['sitemap']['pages'][number],
  anchorPath: string,
  anchorHtml: string,
  stylesheet: string,
) {
  return client.call({
    tier: 'terra',
    label: `terra:build:${page.path}`,
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 32_000,
    effort: 'high',
    prompt: `Build exactly one file: "${page.path}".

Match the existing site exactly. Reuse the header, navigation and footer markup from the
reference page verbatim, and use only classes that already exist in the stylesheet — you
are not returning styles.css, so any new class you invent will be unstyled.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

PAGE TO BUILD
${JSON.stringify(page, null, 2)}

REFERENCE PAGE (${anchorPath})
${anchorHtml}

STYLESHEET (styles.css, for reference — do not return it)
${stylesheet}`,
  });
}
