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
import type * as z from 'zod/v4';
import type { ModelCallOptions, ModelInvocationResult, ModelRuntime } from '../runtime.js';
import {
  TERRA_MAX_MODEL_TURNS,
  TERRA_MAX_RETURNED_BYTES,
  TERRA_MAX_TOOL_CALLS,
  TerraBuildAction,
  ToolLoopBudgetExhausted,
  type ToolAccess,
} from '../tool-access.js';

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

You are designing, not filling in a template. The bar is a site a design-led
studio would put in a portfolio, and the most common failure is a page that is
technically correct and completely characterless: a stack of identical centred
sections, each with a heading, a paragraph and three equal cards.

COMPOSITION — the page must have a shape
- Vary the section forms. A good page alternates between: a full-bleed band in a
  solid dark or accent colour, a contained asymmetric two-column grid, a wide
  edge-to-edge feature, and a narrow editorial column. Never run three
  consecutive sections with the same silhouette.
- Asymmetric beats symmetric. \`lg:grid-cols-[1.15fr_0.85fr]\` or a 12-column grid
  with uneven spans reads as designed; three equal columns reads as a default.
- Vary vertical rhythm deliberately: a hero and a closing section breathe
  (\`py-24 lg:py-32\`), a call-to-action band is tight (\`py-8\`), body sections sit
  between. Identical padding on every section is the single clearest sign that
  nobody made a decision.
- At least one section per page must break the container and run edge to edge.
- Anchor the first screen with something other than centred text. Offset the
  headline, set it against a filled panel, run a bordered card into the margin.

TYPOGRAPHY — the strongest tool you have
- Display type must be dramatically larger than body copy, not one step up.
  A page headline is \`text-5xl sm:text-6xl lg:text-7xl\` with \`leading-[0.95]\`
  and \`tracking-tight\`. Section headings sit well below it. If your h1 and h2
  are within one size step, the hierarchy has collapsed.
- Cap the measure on EVERY paragraph of running text — \`max-w-2xl\` or
  \`max-w-prose\`. A page with no measure cap anywhere is wrong. Full-width
  paragraphs at 18px are unreadable and look unconsidered.
- Use small uppercase eyebrow labels above section headings:
  \`text-xs font-semibold uppercase tracking-[0.18em]\`. They cost nothing and
  immediately read as art-directed.
- Two families, no more, both from the brand system. Weight and size carry the
  hierarchy, not extra fonts.

COLOUR — restraint is the whole trick
- Include at least one dark section per page. Contrast between light and dark
  bands is what gives a page structure at a glance.
- The accent marks one thing at a time: the primary action, a single statistic,
  a rule under a heading. An accent used on six elements stops being an accent.
- Prefer borders and surface shifts (\`bg-card\`, \`border-border\`) to drop
  shadows. Heavy shadows on flat colour read as a 2016 bootstrap theme.

DEPTH WITHOUT PHOTOGRAPHY
There is no image pipeline, so nothing can lean on a stock photo. Everything
must come from type, colour, shape and space. Use, sparingly and with purpose:
oversized numerals for steps or years; thick horizontal rules; inline SVG line
work you author; flat colour blocks and offset panels that overlap a boundary;
one large lucide glyph at low \`strokeWidth\` as a graphic rather than an icon;
and real negative space. Never leave a wide grey rectangle where a photo would
have gone — compose as though the absence were the intention.

DETAIL
- Interactive elements get a visible hover and focus transition.
- The brand system's \`radius\` is the site's only radius: \`square\` means
  \`rounded-none\`, \`subtle\` means \`rounded-md\`, \`rounded\` means \`rounded-2xl\`.
  Apply it consistently to cards, buttons, inputs and panels. One border weight.
- A card needs a reason to exist. Content that is really a list should be a
  list with rules between items, not five boxes.

NEVER
Three equal cards under every heading · everything centred · identical padding
on every section · emoji as icons · gradient text · purple-to-blue gradients ·
\`text-gray-500\` on white as the body colour · a hero that is a headline, a
paragraph and two buttons with nothing else in it.

SECTION LAYOUTS
Every section in the specification names a \`layout\`. Build that form. It is the
plan's compositional decision, not a suggestion, and it is what gives the page a
shape rather than a stack.

  split-hero        Asymmetric grid, e.g. \`lg:grid-cols-[1.15fr_0.85fr]\`. Headline
                    oversized and hard left, never centred. The right cell is a
                    bordered or filled panel carrying the primary action and one
                    supporting fact. Give the panel a graphic anchor: a flat colour
                    block breaking a corner, or one large icon at low strokeWidth.
  accent-band       Full-bleed accent colour, tight vertical padding (\`py-8\`), one
                    line of copy and one button, laid out \`md:grid-cols-[1fr_auto]\`.
  stat-strip        Full-bleed dark. Two to four figures at \`text-5xl\` or larger in
                    the heading face, each with a small uppercase caption beneath.
                    Separated by borders, not gaps.
  feature-grid      \`md:grid-cols-2 lg:grid-cols-3\` with the first card inverted
                    (filled with the primary colour) so the grid has a focal point.
  rule-list         Full-width rows, \`divide-y divide-border\`, no cards. Each row is
                    a title, a line of copy and optionally a small right-aligned
                    detail. This is the correct form for most lists.
  numbered-steps    Ordinals at \`text-6xl\` or larger in the heading face, set in a
                    narrow left column with the copy beside them.
  editorial-split   \`lg:grid-cols-[0.35fr_0.65fr]\`. Hanging labels or metadata left,
                    prose right at \`max-w-prose\`. Never full-bleed running text.
  detail-table      Key/value rows with a hairline between. Labels small and
                    uppercase, values in the body face.
  faq-accordion     The Accordion primitive. Genuine questions only.
  contact-panel     Two columns: the form one side, real address, phone and email the
                    other. Both reachable at 320px.
  closing-cta       Full-bleed dark, generous padding, one heading and one action.

Two adjacent sections never share a layout, and the plan will not ask you to.

ART DIRECTION
The brand system carries an \`artDirection\` note describing the compositional
character this specific business calls for. Follow it. It is what stops a
joinery workshop, a pizzeria and a law firm from receiving the same page with
different words in it.

ACCESSIBILITY AND CORRECTNESS
- Responsive from 320px up: fluid type, sensible max-widths, wrapping layouts.
- One <h1> per page, no skipped heading levels, labelled form controls, alt or
  aria-hidden on every graphic.
- Every link needs a discernible name. A link whose only content is an icon has
  none — give it \`aria-label\`, or include visually-hidden text (\`sr-only\`).
  This is the single most common accessibility finding on generated sites.
- Contrast must hold on dark sections too: check body text against the surface
  it actually sits on, not against the page background.
- A contact form cannot submit to a \`mailto:\` action. Browser handling is
  inconsistent and a completed enquiry is silently lost. Point the form at a real
  endpoint path, and put the email address on the page as a link people can use.`;

const SYSTEM = `You are Terra, a senior frontend engineer building a complete small-business website.

${STACK}`;

/** Per-call options for a Terra build: cancellation, and any tools the harness granted. */
export interface TerraBuildOptions extends ModelCallOptions {
  readonly tools?: ToolAccess;
}

interface TerraBuildRequest {
  readonly label: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly effort: 'high' | 'xhigh';
}

function inspectionSection(transcript: readonly string[], remaining: number): string {
  return `

INSPECTING THE SCAFFOLD
Your files are added to a fixed platform scaffold you have not been shown: the
shadcn components in components/ui/, the theme in app/globals.css, the template
app/layout.tsx, lib/utils.ts, package.json and its configuration. Before
answering you may read up to ${remaining} more of those files, one per response —
to check a component's exact props and variants, or the theme you are extending.
Paths are relative to the site root. Reading never changes anything.

Respond with exactly one JSON action:
  {"action":"tool","tool":"filesystem","input":{"path":"components/ui/card.tsx"},"output":null}
  {"action":"final","tool":null,"input":null,"output":<the complete build output>}

FILES READ SO FAR
${transcript.length === 0 ? '(none)' : transcript.join('\n\n')}`;
}

/**
 * Every Terra build invocation, bounded.
 *
 * Without granted tools this is exactly one invocation with exactly the prompt
 * and schema a build always had. With them, each turn is still one ordinary
 * runtime invocation — its own usage, the same skill and tier — whose answer is
 * either one tool request, carried out by the harness's gateway and fed back,
 * or the final build. Bounded by turns, tool calls and returned bytes, and
 * stopped by the signal between every step. Callers only ever see the final
 * `BuildOutput`.
 */
async function invokeTerraBuild(
  runtime: ModelRuntime,
  request: TerraBuildRequest,
  options: TerraBuildOptions,
): Promise<ModelInvocationResult<BuildOutput>> {
  const tools = options.tools?.grantedTools.includes('filesystem') ? options.tools : undefined;
  const transcript: string[] = [];
  const answered = new Map<string, string>();
  let toolCalls = 0;
  let returnedBytes = 0;

  for (let turn = 0; turn < (tools ? TERRA_MAX_MODEL_TURNS : 1); turn += 1) {
    options.signal?.throwIfAborted();

    const result = await runtime.invoke({
      skill: 'terra-build',
      tier: 'terra',
      label: request.label,
      system: SYSTEM,
      schema: (tools ? TerraBuildAction : BuildOutput) as z.ZodType<unknown>,
      maxTokens: request.maxTokens,
      effort: request.effort,
      prompt: tools ? request.prompt + inspectionSection(transcript, TERRA_MAX_TOOL_CALLS - toolCalls) : request.prompt,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if (!tools) return result as ModelInvocationResult<BuildOutput>;

    const action = result.value as TerraBuildAction;
    if (action.action === 'final') return { ...result, value: action.output! };

    // A repeat of a read already answered is served from this build's own
    // record: it executes nothing and spends no tool call, but it still spends
    // a turn — which is what keeps the turn limit meaningful on its own.
    const key = JSON.stringify([action.tool, action.input]);
    let fed = answered.get(key);
    if (fed === undefined && toolCalls >= TERRA_MAX_TOOL_CALLS) {
      throw new ToolLoopBudgetExhausted('tool_calls', TERRA_MAX_TOOL_CALLS);
    }
    // A read requested on the last turn could never be used: refused before it runs.
    if (turn + 1 >= TERRA_MAX_MODEL_TURNS) throw new ToolLoopBudgetExhausted('model_turns', TERRA_MAX_MODEL_TURNS);
    options.signal?.throwIfAborted();

    if (fed === undefined) {
      toolCalls += 1;
      const outcome = await tools.execute({ tool: action.tool!, input: action.input }, options.signal);
      if (outcome.ok) {
        returnedBytes += Buffer.byteLength(outcome.content, 'utf8');
        if (returnedBytes > TERRA_MAX_RETURNED_BYTES) {
          throw new ToolLoopBudgetExhausted('returned_bytes', TERRA_MAX_RETURNED_BYTES);
        }
      }
      options.signal?.throwIfAborted();
      fed = JSON.stringify(outcome);
      answered.set(key, fed);
    }
    transcript.push(fed);
  }

  throw new ToolLoopBudgetExhausted('model_turns', TERRA_MAX_MODEL_TURNS);
}

export async function buildSite(runtime: ModelRuntime, profile: BusinessProfile, plan: SitePlan, options: TerraBuildOptions = {}) {
  return invokeTerraBuild(
    runtime,
    {
      label: 'terra:build',
      maxTokens: 128_000,
      effort: 'xhigh',
      prompt: `Build this website completely. Return every file you write.

Routes to create:
${plan.sitemap.pages.map((p) => `  ${p.route}  →  ${routeToSourcePath(p.route)}`).join('\n')}

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

APPROVED PLAN
${JSON.stringify(plan, null, 2)}`,
    },
    options,
  );
}

/**
 * Decomposition step one: the design anchor.
 *
 * Builds the shared layout, the brand tokens and the homepage together, so the
 * design system is written against real markup rather than in the abstract.
 * Every later page is built to match this, which is what keeps separately
 * generated pages looking like one site.
 */
export async function buildAnchor(runtime: ModelRuntime, profile: BusinessProfile, plan: SitePlan, options: TerraBuildOptions = {}) {
  const home = plan.sitemap.pages.find((p) => p.route === HOME_ROUTE) ?? plan.sitemap.pages[0]!;

  return invokeTerraBuild(
    runtime,
    {
      label: 'terra:build:anchor',
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
    },
    options,
  );
}

/**
 * Decomposition step two: one page, built against the anchor.
 *
 * The layout and homepage are supplied as the pattern to match. This is the
 * smallest unit that still produces a coherent site, and keeps each call far
 * below the output ceiling that defeats the whole-site attempt.
 */
export async function buildPage(
  runtime: ModelRuntime,
  profile: BusinessProfile,
  plan: SitePlan,
  page: PageSpec,
  anchorSource: string,
  layoutSource: string,
  options: TerraBuildOptions = {},
) {
  return invokeTerraBuild(
    runtime,
    {
      label: `terra:build:${page.route}`,
      maxTokens: 32_000,
      effort: 'high',
      prompt: `Build exactly one file: ${routeToSourcePath(page.route)}

Match the existing site. The layout already provides the header, navigation and
footer, so this file contains only the page's own content. Use the same
components, spacing and tone as the reference page below, and only classes and
components that already appear there or in the shadcn set.

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

ART DIRECTION (the same brief the homepage was built to)
${plan.brandSystem.artDirection}

PAGE SPECIFICATION
${JSON.stringify(page, null, 2)}

SHARED LAYOUT (app/layout.tsx — for reference, do not return it)
${layoutSource}

REFERENCE PAGE (the homepage — for reference, do not return it)
${anchorSource}`,
    },
    options,
  );
}
