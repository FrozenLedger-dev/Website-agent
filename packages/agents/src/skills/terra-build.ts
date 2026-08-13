/**
 * Terra — website build (v1.2 §3, "One-Shot First").
 *
 * Emits Next.js App Router source against a scaffold the platform owns. The
 * builder writes pages, the layout and site components; it never writes
 * configuration, dependencies or the shadcn primitives, so a build failure is
 * always about the site rather than about the toolchain.
 */
import {
  BuildOutput,
  HOME_ROUTE,
  routeToSourcePath,
  type BusinessProfile,
  type PageSpec,
  type SitePlan,
} from '@statxai/contracts';
import type { ModelClient } from '../client.js';

/**
 * lucide-react exports that are known to exist.
 *
 * Verified against the installed package rather than recalled: a build died on
 * `import { Window } from 'lucide-react'`, which is not an icon. An import that
 * does not resolve is a P0 the repair budget then grinds against, and the model
 * has no way to check the package from inside a single call.
 *
 * Brand marks are deliberately absent — lucide removed them, so `Facebook` and
 * `Instagram` are exactly the plausible guesses that fail.
 *
 * `pnpm scaffold:check` compiles a page importing every one of these, so the
 * list cannot drift from the package the scaffold pins.
 */
export const LUCIDE_ICONS = [
  'Phone',
  'Mail',
  'MapPin',
  'Clock',
  'Calendar',
  'Send',
  'MessageSquare',
  'ArrowRight',
  'ArrowLeft',
  'ChevronRight',
  'ChevronDown',
  'Check',
  'CheckCircle2',
  'Star',
  'Quote',
  'Hammer',
  'Wrench',
  'Ruler',
  'PencilRuler',
  'Drill',
  'Axe',
  'Layers',
  'Package',
  'Truck',
  'Home',
  'Building2',
  'Warehouse',
  'DoorOpen',
  'DoorClosed',
  'PanelTop',
  'Square',
  'Sparkles',
  'Award',
  'Shield',
  'ShieldCheck',
  'BadgeCheck',
  'ThumbsUp',
  'Heart',
  'Leaf',
  'TreePine',
  'Trees',
  'Paintbrush',
  'PaintRoller',
  'Palette',
  'Lightbulb',
  'Sun',
  'Moon',
  'Users',
  'User',
  'UserCheck',
  'Handshake',
  'Briefcase',
  'FileText',
  'ClipboardCheck',
  'ListChecks',
  'Search',
  'Menu',
  'X',
  'Plus',
  'Minus',
  'Info',
  'CircleHelp',
  'TriangleAlert',
  'Camera',
  'Image',
  'Play',
  'Compass',
  'Target',
  'Zap',
  'Flame',
  'Droplet',
  'Scissors',
  'Settings',
  'Cog',
  'Key',
  'Lock',
  'Globe',
] as const;

const STACK = `THE PROJECT

Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui. Static export
(\`output: 'export'\`), so every page is prerendered to HTML at build time.

You write ONLY these files:
  app/page.tsx              the homepage (route "/")
  app/<segment>/page.tsx    one directory per route, e.g. app/services/page.tsx
  app/layout.tsx            the shared shell: header, nav, footer, <html>/<body>
  app/globals.css           brand tokens only — append, never replace the file
  components/site/*.tsx     site-specific components you introduce

You must NOT write package.json, any config file, lib/, or components/ui/.
They already exist and are correct. Writing them is refused.

AVAILABLE COMPONENTS — import from "@/components/ui/<name>":
  accordion  badge  button  card  input  label  separator  sheet  textarea

Importing anything else from components/ui fails the build. Compose what you
need from these plus Tailwind utilities and the icons below.

AVAILABLE ICONS — import from "lucide-react":
  Phone  Mail  MapPin  Clock  Calendar  Send  MessageSquare  ArrowRight
  ArrowLeft  ChevronRight  ChevronDown  Check  CheckCircle2  Star  Quote
  Hammer  Wrench  Ruler  PencilRuler  Drill  Axe  Layers  Package  Truck
  Home  Building2  Warehouse  DoorOpen  DoorClosed  PanelTop  Square
  Sparkles  Award  Shield  ShieldCheck  BadgeCheck  ThumbsUp  Heart  Leaf
  TreePine  Trees  Paintbrush  PaintRoller  Palette  Lightbulb  Sun  Moon
  Users  User  UserCheck  Handshake  Briefcase  FileText  ClipboardCheck
  ListChecks  Search  Menu  X  Plus  Minus  Info  CircleHelp  TriangleAlert
  Camera  Image  Play  Compass  Target  Zap  Flame  Droplet  Scissors
  Settings  Cog  Key  Lock  Globe

These names are verified to exist. Any other import from lucide-react fails the
build, and guessing is easy: the brand marks (Facebook, Instagram, Twitter) were
removed from the package and do not exist.

To style a link as a button, use \`asChild\` with a single element child:
  <Button asChild size="lg"><Link href="/services">Our services</Link></Button>
Badge accepts it too. This renders the child element with the button's styling,
so the result is a real anchor rather than a button wrapping a link.

RULES THE BUILD ENFORCES
- app/layout.tsx MUST type its props as \`LayoutProps<'/'>\` — the type Next
  generates for the route. Writing \`{ children: React.ReactNode }\` by hand
  type-checks and then fails the build at prerender with an error that names
  neither the layout nor the real cause. Do not import that type; it is global.
- app/layout.tsx MUST keep \`import './globals.css';\` at the top. It is the only
  thing that pulls Tailwind and the theme into the build. A layout that omits it
  compiles, exports, and produces a site with no stylesheet at all — plain black
  text on white. This has happened; the gates catch it, but only after a full
  build has been paid for.
- Load the brand faces in app/layout.tsx with next/font/google, which downloads
  and self-hosts them at build time:
    import { Cormorant_Garamond, Inter_Tight } from 'next/font/google';
    const heading = Cormorant_Garamond({ subsets: ['latin'], variable: '--font-heading', display: 'swap' });
    const body = Inter_Tight({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
    <html lang="en" className={\`\${heading.variable} \${body.variable}\`}>
  The import name is the family with spaces as underscores. Apply the faces with
  \`font-[family-name:var(--font-heading)]\` or a Tailwind theme token. A family
  named in CSS but never loaded this way renders as a fallback, and the
  typography gate blocks the release for it.
- Every page is a server component. Add "use client" only to a component that
  genuinely needs interactivity, and keep it in components/site/.
- Each page exports \`metadata\` with a title and description:
    export const metadata: Metadata = { title: "…", description: "…" };
- Internal links use next/link: <Link href="/services">…</Link>. Never <a> for
  internal routes, and never link to a route the sitemap does not contain.
- No next/image with remote URLs — there is no asset pipeline and remote images
  would 404. Build visuals from Tailwind, CSS and inline SVG you author.
- TypeScript must compile. An import that does not resolve fails the build.

CONTENT
- Every factual claim must trace to the business profile. Do not invent
  testimonials, awards, certifications, statistics, prices, guarantees,
  response times or aftercare commitments. If the profile does not support a
  claim, the site does not make it.
- No placeholder text: no lorem ipsum, no "Your Company", no TODO, no
  example.com, no 555 phone numbers. Use the real details from the profile.
- Write real copy in the profile's tone. Every section should say something
  specific to this business that could not be pasted onto a competitor's site.

DESIGN
- Apply the brand system through Tailwind utilities and CSS custom properties
  in globals.css. Use the shadcn theme tokens (bg-background, text-foreground,
  text-muted-foreground, border) so light and dark both work.
- Responsive from 320px up: fluid type, sensible max-widths, wrapping layouts.
- Accessible: one <h1> per page, no skipped heading levels, labelled form
  controls, alt or aria-hidden on every graphic.
- Every link needs a discernible name. A link whose only content is an icon has
  none — give it \`aria-label\`, or include visually-hidden text (\`sr-only\`).
  This is the single most common accessibility finding on generated sites.
- A contact form cannot submit to a \`mailto:\` action. Browser handling is
  inconsistent and a completed enquiry is silently lost. Point the form at a real
  endpoint path, and put the email address on the page as a link people can use.`;

const SYSTEM = `You are Terra, a senior frontend engineer building a complete small-business website.

${STACK}`;

export async function buildSite(client: ModelClient, profile: BusinessProfile, plan: SitePlan) {
  return client.call({
    tier: 'terra',
    label: 'terra:build',
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 128_000,
    effort: 'xhigh',
    prompt: `Build this website completely. Return every file you write.

Routes to create:
${plan.sitemap.pages.map((p) => `  ${p.route}  →  ${routeToSourcePath(p.route)}`).join('\n')}

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

APPROVED PLAN
${JSON.stringify(plan, null, 2)}`,
  });
}

/**
 * Decomposition step one: the design anchor.
 *
 * Builds the shared layout, the brand tokens and the homepage together, so the
 * design system is written against real markup rather than in the abstract.
 * Every later page is built to match this, which is what keeps separately
 * generated pages looking like one site.
 */
export async function buildAnchor(client: ModelClient, profile: BusinessProfile, plan: SitePlan) {
  const home = plan.sitemap.pages.find((p) => p.route === HOME_ROUTE) ?? plan.sitemap.pages[0]!;

  return client.call({
    tier: 'terra',
    label: 'terra:build:anchor',
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 48_000,
    effort: 'xhigh',
    prompt: `Build exactly these files and no others:

  app/layout.tsx      the shared shell — header, navigation, footer, metadata
  app/globals.css     brand tokens appended to the existing shadcn theme
  ${routeToSourcePath(home.route)}      the homepage
  components/site/*   any shared components the shell needs

This establishes the design system. Later pages are built to match it exactly,
so the header, navigation and footer you write here are the pattern. The
navigation must link to every route in the sitemap.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

BRAND SYSTEM
${JSON.stringify(plan.brandSystem, null, 2)}

ALL ROUTES (for navigation)
${plan.sitemap.pages.map((p) => `  ${p.route}  ${p.title}`).join('\n')}

HOMEPAGE SPECIFICATION
${JSON.stringify(home, null, 2)}`,
  });
}

/**
 * Decomposition step two: one page, built against the anchor.
 *
 * The layout and homepage are supplied as the pattern to match. This is the
 * smallest unit that still produces a coherent site, and keeps each call far
 * below the output ceiling that defeats the whole-site attempt.
 */
export async function buildPage(
  client: ModelClient,
  profile: BusinessProfile,
  plan: SitePlan,
  page: PageSpec,
  anchorSource: string,
  layoutSource: string,
) {
  return client.call({
    tier: 'terra',
    label: `terra:build:${page.route}`,
    system: SYSTEM,
    schema: BuildOutput,
    maxTokens: 32_000,
    effort: 'high',
    prompt: `Build exactly one file: ${routeToSourcePath(page.route)}

Match the existing site. The layout already provides the header, navigation and
footer, so this file contains only the page's own content. Use the same
components, spacing and tone as the reference page below, and only classes and
components that already appear there or in the shadcn set.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

PAGE SPECIFICATION
${JSON.stringify(page, null, 2)}

SHARED LAYOUT (app/layout.tsx — for reference, do not return it)
${layoutSource}

REFERENCE PAGE (the homepage — for reference, do not return it)
${anchorSource}`,
  });
}
