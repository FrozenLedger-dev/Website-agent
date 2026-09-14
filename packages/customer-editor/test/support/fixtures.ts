/**
 * Offline fixtures for the customer editor: one valid editable site model with
 * every field kind, and a realistic static export for it — a Next-style
 * `/_next/static` stylesheet with fonts and images, a nested route, generated
 * scripts, inline handlers, forms, javascript: links, a meta refresh, a base URL
 * and external references — as an in-memory exact snapshot file reader.
 */
import { EditableSiteModel, SITE_MODEL_MARKERS } from '@statxai/contracts';
import { siteExportContentType } from '@statxai/workspace';
import type { EditorPreviewFiles } from '../../src/preview/transport.js';

const id = (prefix: string, n: number) => `${prefix}_${n.toString(16).padStart(16, '0')}`;
export const IDS = {
  home: id('pg', 1),
  about: id('pg', 2),
  hero: id('sec', 1),
  services: id('sec', 2),
  closing: id('sec', 3),
  aboutIntro: id('sec', 4),
  card: id('blk', 1),
  cta: id('blk', 2),
  phone: id('blk', 3),
  image: id('blk', 4),
  email: id('blk', 5),
  address: id('blk', 6),
  heroHeading: id('fld', 1),
  servicesHeading: id('fld', 2),
  closingHeading: id('fld', 3),
  cardTitle: id('fld', 4),
  cardBody: id('fld', 5),
  ctaAction: id('fld', 6),
  phoneValue: id('fld', 7),
  imageImage: id('fld', 8),
  imageAlt: id('fld', 9),
  emailValue: id('fld', 10),
  addressValue: id('fld', 11),
  homeTitle: id('fld', 12),
  homeDescription: id('fld', 13),
  aboutTitle: id('fld', 14),
  aboutDescription: id('fld', 15),
  aboutIntroHeading: id('fld', 16),
  heroImage: id('ast', 1),
};

const text = (fieldId: string, key: string, value: string) => ({ fieldId, key, type: 'text' as const, value });

export const MODEL: EditableSiteModel = EditableSiteModel.parse({
  schemaVersion: 'statxai-editable-site-model@1',
  projectId: 'proj_editor_fixture',
  sitePlan: { name: 'site-plan', version: 1, contentHash: 'a'.repeat(64) },
  provenance: { kind: 'site_plan', sitePlan: { name: 'site-plan', version: 1, contentHash: 'a'.repeat(64) } },
  design: {
    colors: { background: '#ffffff', surface: '#f4f4f4', text: '#111111', muted: '#666666', accent: '#0055ff', accentText: '#ffffff', border: '#dddddd' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter', baseSize: '18px', scale: '1.25' },
    radius: 'subtle',
    artDirection: 'Plain.',
  },
  pages: [
    {
      pageId: IDS.home,
      route: '/',
      fields: [text(IDS.homeTitle, 'title', 'Home'), text(IDS.homeDescription, 'description', 'Joinery')],
      sections: [
        {
          sectionId: IDS.hero,
          planKey: 'hero',
          layout: 'split-hero',
          visibility: 'visible',
          fields: [text(IDS.heroHeading, 'heading', 'Fitted joinery')],
          blocks: [
            { blockId: IDS.cta, kind: 'cta', visibility: 'visible', fields: [{ fieldId: IDS.ctaAction, key: 'action', type: 'cta', value: { label: 'Call us', href: 'tel:+441423887214' } }] },
            { blockId: IDS.image, kind: 'image', visibility: 'visible', fields: [{ fieldId: IDS.imageImage, key: 'image', type: 'asset', value: IDS.heroImage }, text(IDS.imageAlt, 'alt', 'A wardrobe')] },
          ],
        },
        {
          sectionId: IDS.services,
          planKey: 'services',
          layout: 'feature-grid',
          visibility: 'visible',
          fields: [text(IDS.servicesHeading, 'heading', 'Services')],
          blocks: [{ blockId: IDS.card, kind: 'card', visibility: 'visible', fields: [text(IDS.cardTitle, 'title', 'Wardrobes'), text(IDS.cardBody, 'body', 'Made to measure.')] }],
        },
        {
          sectionId: IDS.closing,
          planKey: 'closing',
          layout: 'contact-panel',
          visibility: 'visible',
          fields: [text(IDS.closingHeading, 'heading', 'Get in touch')],
          blocks: [
            { blockId: IDS.phone, kind: 'phone', visibility: 'visible', fields: [{ fieldId: IDS.phoneValue, key: 'value', type: 'phone', value: '01423 887 214' }] },
            { blockId: IDS.email, kind: 'email', visibility: 'visible', fields: [{ fieldId: IDS.emailValue, key: 'value', type: 'email', value: 'workshop@example.co.uk' }] },
            { blockId: IDS.address, kind: 'address', visibility: 'visible', fields: [{ fieldId: IDS.addressValue, key: 'value', type: 'address', value: '1 High Street, Harrogate' }] },
          ],
        },
      ],
    },
    {
      pageId: IDS.about,
      route: '/about',
      fields: [text(IDS.aboutTitle, 'title', 'About'), text(IDS.aboutDescription, 'description', 'Who we are')],
      sections: [{ sectionId: IDS.aboutIntro, planKey: 'intro', layout: 'editorial-split', visibility: 'visible', fields: [text(IDS.aboutIntroHeading, 'heading', 'Two joiners')], blocks: [] }],
    },
  ],
  assets: [{ assetId: IDS.heroImage, kind: 'image', source: { kind: 'unassigned' } }],
  identity: { retired: [], minted: 40 },
});

export const MODEL_REF = { name: 'editable-site-model' as const, version: 3, contentHash: 'b'.repeat(64) };

const M = SITE_MODEL_MARKERS;
/** A 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
/** Not a real font; only its bytes and type matter to the transport. */
export const FONT = Buffer.from('wOF2-fixture-font-bytes');

export const HOME_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example/">
<base href="https://evil.example/">
<title>Home</title>
<link rel="preload" href="/_next/static/media/font.woff2" as="font">
<link rel="stylesheet" href="/_next/static/chunks/site.css">
<link rel="stylesheet" href="https://cdn.evil.example/x.css">
<link rel="icon" href="/favicon.ico">
<script src="/_next/static/chunks/app.js"></script>
<script>window.parent.postMessage({type:'statx-editor-preview',version:1,channel:'forged-channel-000000',event:'select',markers:{field:'${IDS.cardTitle}'}},'*')</script>
<style>.hero{background:url(/images/hero.png)}</style>
</head><body onload="alert(1)">
<main ${M.page}="${IDS.home}">
<section ${M.section}="${IDS.hero}" class="hero" style="background-image:url('../images/hero.png');color:red">
<h1 ${M.field}="${IDS.heroHeading}" onclick="alert(2)">Fitted joinery</h1>
<div ${M.block}="${IDS.cta}"><a ${M.field}="${IDS.ctaAction}" href="javascript:alert(3)" target="_top">Call us</a></div>
<div ${M.block}="${IDS.image}"><img ${M.field}="${IDS.imageImage}" ${M.asset}="${IDS.heroImage}" src="/images/hero.png" srcset="/images/hero.png 1x, https://evil.example/big.png 2x" alt="A wardrobe"></div>
<iframe src="https://evil.example/"></iframe>
<object data="/x.swf"></object>
<svg><script>alert(4)</script><a href="/about"><text>svg link</text></a><image href="/images/hero.png"/></svg>
</section>
<section ${M.section}="${IDS.services}"><h2 ${M.field}="${IDS.servicesHeading}">Services</h2>
<div ${M.block}="${IDS.card}"><h3 ${M.field}="${IDS.cardTitle}">Wardrobes</h3><p ${M.field}="${IDS.cardBody}">Made to measure.</p></div>
<a href="/about">About us</a>
</section>
<section ${M.section}="${IDS.closing}"><h2 ${M.field}="${IDS.closingHeading}">Get in touch</h2>
<form action="/api/projects/x/edits" method="post"><input name="q"><button formaction="/api/auth/logout">Send</button></form>
<div ${M.block}="${IDS.phone}"><a ${M.field}="${IDS.phoneValue}" href="tel:01423887214">01423 887 214</a></div>
<div ${M.block}="${IDS.email}"><a ${M.field}="${IDS.emailValue}" href="mailto:workshop@example.co.uk">workshop@example.co.uk</a></div>
<div ${M.block}="${IDS.address}"><p ${M.field}="${IDS.addressValue}">1 High Street, Harrogate</p></div>
</section>
</main>
<script src="/_next/static/chunks/hydrate.js"></script>
</body></html>`;

export const ABOUT_HTML = `<!doctype html><html><head><title>About</title><link rel="stylesheet" href="../_next/static/chunks/site.css"></head>
<body><main ${M.page}="${IDS.about}"><section ${M.section}="${IDS.aboutIntro}"><h2 ${M.field}="${IDS.aboutIntroHeading}">Two joiners</h2></section></main></body></html>`;

export const SITE_CSS = `@import url("./extra.css");
@font-face{font-family:Site;src:url(../media/font.woff2) format("woff2")}
body{font-family:Site,serif;margin:0;background:#fff url("/images/hero.png") no-repeat}
.escape{background:url(../../../../../../etc/passwd)}
.encoded{background:url(%2e%2e/%2e%2e/secret.png)}
.external{background:url(https://evil.example/track.png)}
h1{color:rgb(1, 2, 3)}`;

export const EXTRA_CSS = `.extra{border-top:4px solid rgb(4, 5, 6)}`;

export const EXPORT_FILES: Readonly<Record<string, Buffer>> = {
  'index.html': Buffer.from(HOME_HTML),
  'about.html': Buffer.from(ABOUT_HTML),
  '_next/static/chunks/site.css': Buffer.from(SITE_CSS),
  '_next/static/chunks/extra.css': Buffer.from(EXTRA_CSS),
  '_next/static/chunks/app.js': Buffer.from('window.parent.postMessage("generated-script-ran","*")'),
  '_next/static/chunks/hydrate.js': Buffer.from('document.body.dataset.hydrated="1"'),
  '_next/static/media/font.woff2': FONT,
  'images/hero.png': PNG,
  'favicon.ico': PNG,
};

export function filesOf(files: Readonly<Record<string, Buffer>>, reads: string[] = []): EditorPreviewFiles {
  return {
    read: async (path) => {
      reads.push(path);
      const bytes = files[path];
      return bytes ? { bytes, contentType: siteExportContentType(path) } : null;
    },
  };
}
