/**
 * The editor preview's isolation in a real browser.
 *
 * A local origin plays the customer app: it sets a customer-style session
 * cookie, serves an editor page framing the preview exactly as the customer
 * editor does (`sandbox="allow-scripts"`, no same-origin), serves the preview
 * document produced by the real transport with its real CSP, and exposes a
 * stand-in authenticated mutation endpoint that records every request. Chrome
 * then proves what the generated page can and cannot do.
 *
 * Integration: needs Chrome (CHROME_PATH, default /usr/bin/google-chrome).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { SITE_MODEL_MARKERS } from '@statxai/contracts';
import { renderEditorPreviewDocument } from '../src/preview/transport.js';
import { PREVIEW_MESSAGE_TYPE, editorModelView, parsePreviewMessage, selectFromMarkers, type MarkerChain } from '../src/client.js';
import { EXPORT_FILES, IDS, MODEL, filesOf } from './support/fixtures.js';

// Browser globals, for the callbacks Playwright runs inside the page or frame.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any, document: any, self: any, getComputedStyle: any;

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const CHANNEL = 'channel_browser_0123456789';
const view = editorModelView(MODEL);

interface Hit {
  readonly method: string;
  readonly url: string;
  readonly cookie: boolean;
  readonly site: string | undefined;
}

let server: Server;
let origin: string;
let browser: Browser;
let hits: Hit[] = [];

/** The editor page: the frame exactly as the customer editor mounts it, and the editor's own message acceptance rule. */
const EDITOR_PAGE = (route: string) => `<!doctype html><html><body>
<iframe id="preview" title="Draft preview" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/preview${route}?channel=${CHANNEL}" style="width:1000px;height:800px"></iframe>
<iframe id="other" src="/other"></iframe>
<script>
  window.accepted = []; window.ignored = [];
  addEventListener('message', (event) => {
    const frame = document.getElementById('preview');
    if (event.source !== frame.contentWindow) { window.ignored.push(event.data); return; }
    window.accepted.push(event.data);
  });
</script></body></html>`;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    hits.push({ method: req.method ?? 'GET', url: url.pathname + url.search, cookie: (req.headers.cookie ?? '').includes('statx_customer_session='), site: req.headers['sec-fetch-site'] as string | undefined });
    if (url.pathname === '/editor' || url.pathname === '/editor/about') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `statx_customer_session=${'A'.repeat(43)}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end(EDITOR_PAGE(url.pathname === '/editor/about' ? '/about' : ''));
    }
    if (url.pathname === '/preview' || url.pathname === '/preview/about') {
      const doc = await renderEditorPreviewDocument({ files: filesOf(EXPORT_FILES), documentPath: url.pathname === '/preview' ? 'index.html' : 'about.html', channel: url.searchParams.get('channel')! });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': doc.contentSecurityPolicy, 'x-content-type-options': 'nosniff' });
      return res.end(doc.html);
    }
    if (url.pathname === '/other') {
      // A same-origin frame that is not the preview, forging a perfectly valid preview message.
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<script>parent.postMessage(${JSON.stringify({ type: PREVIEW_MESSAGE_TYPE, version: 1, channel: CHANNEL, event: 'select', markers: { field: IDS.cardTitle } })}, '*')</script>`);
    }
    // Anything else — including the stand-in mutation API — is recorded and answered.
    res.writeHead(url.pathname.startsWith('/api/') ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

beforeEach(() => {
  hits = [];
});

async function open(route = ''): Promise<{ page: Page; frame: Frame; dialogs: string[] }> {
  const page = await browser.newPage();
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`${origin}/editor${route}`);
  // Load again with the session cookie set, as a signed-in customer's editor would.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { accepted: { event: string }[] }).accepted.some((m) => m.event === 'ready'));
  const frame = page.frames().find((f) => f.url().includes('/preview'))!;
  return { page, frame, dialogs };
}

/** A parsed selection's markers, in the shape selection takes. */
const markersOf = (message: ReturnType<typeof parsePreviewMessage> | undefined): MarkerChain => (message?.event === 'select' ? (Object.fromEntries(Object.entries(message.markers).filter(([, v]) => v !== undefined)) as MarkerChain) : {});

const accepted = (page: Page) => page.evaluate(() => (window as unknown as { accepted: unknown[] }).accepted);
const selections = async (page: Page) => (await accepted(page)).map((m) => parsePreviewMessage(m, CHANNEL)).filter((m) => m?.event === 'select');

async function clickMarker(page: Page, frame: Frame, attribute: string, id: string) {
  const before = (await selections(page)).length;
  await frame.click(`[${attribute}="${id}"]`, { position: { x: 2, y: 2 } });
  await page.waitForFunction((n) => (window as unknown as { accepted: { event: string }[] }).accepted.filter((m) => m.event === 'select').length > n, before);
  return (await selections(page)).at(-1)!;
}

describe('the preview frame has no customer-origin authority', () => {
  it('is sandboxed without same-origin: an opaque origin with no cookies, and its only request is its own document', async () => {
    const { page, frame } = await open();
    expect(await page.getAttribute('#preview', 'sandbox')).toBe('allow-scripts');
    expect(await frame.evaluate(() => self.origin)).toBe('null');
    expect(await frame.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return 'inaccessible';
      }
    })).toBe('inaccessible');
    await page.waitForTimeout(300);
    const fromFrame = hits.filter((h) => h.url.startsWith('/preview'));
    expect(fromFrame.map((h) => h.url)).toEqual([`/preview?channel=${CHANNEL}`, `/preview?channel=${CHANNEL}`]);
    // No stylesheet, font, image, script or API request ever leaves the frame.
    expect(hits.filter((h) => !['/editor', '/other', '/favicon.ico'].includes(h.url) && !h.url.startsWith('/preview'))).toEqual([]);
    await page.close();
  });

  it('runs none of the generated scripts, inline handlers or javascript: links — and cannot navigate, submit or call the customer API', async () => {
    const { page, frame, dialogs } = await open();
    expect(await frame.evaluate(() => document.body.dataset.hydrated ?? null)).toBeNull();
    expect((await accepted(page)).some((m) => JSON.stringify(m).includes('generated-script-ran') || JSON.stringify(m).includes('forged-channel'))).toBe(false);

    await frame.click(`[${SITE_MODEL_MARKERS.field}="${IDS.heroHeading}"]`);
    await frame.click(`[${SITE_MODEL_MARKERS.field}="${IDS.ctaAction}"]`);
    await frame.click('text=About us');
    await frame.click('button:has-text("Send")');
    await frame.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'javascript:alert(5)';
      document.body.append(a);
      a.click();
    }).catch(() => undefined);
    // Even script running in the frame (here, the test's own) cannot reach the customer API: no network, no cookie.
    const fetched = await frame.evaluate(async () => {
      try {
        await fetch('/api/projects/proj_x/edits', { method: 'POST', credentials: 'include', body: '{}' });
        return 'sent';
      } catch {
        return 'blocked';
      }
    });
    expect(fetched).toBe('blocked');
    await page.waitForTimeout(500);

    expect(dialogs).toEqual([]);
    expect(page.url()).toBe(`${origin}/editor`);
    expect(page.frames().find((f) => f.url().includes('/preview'))!.url()).toBe(`${origin}/preview?channel=${CHANNEL}`);
    expect(hits.filter((h) => h.url.startsWith('/api/'))).toEqual([]);
    expect(await frame.evaluate(() => document.body.dataset.hydrated ?? null)).toBeNull();
    await page.close();
  });

  it('opened directly as a top-level page, the preview is still sandboxed by its own CSP: opaque origin, no network', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/editor`);
    await page.goto(`${origin}/preview?channel=${CHANNEL}`);
    expect(await page.evaluate(() => self.origin)).toBe('null');
    expect(await page.evaluate(async () => fetch('/api/projects/proj_x/edits', { method: 'POST' }).then(() => 'sent', () => 'blocked'))).toBe('blocked');
    expect(hits.filter((h) => h.url.startsWith('/api/'))).toEqual([]);
    await page.close();
  });

  it('still renders the generated design from the snapshot: stylesheet, @import, image and font face', async () => {
    const { page, frame } = await open();
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(1, 2, 3)');
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('[data-statx-section-id]')!).backgroundImage.startsWith('url("data:image/png;base64,'))).toBe(true);
    expect(await frame.evaluate(() => document.querySelector('img[data-statx-asset-id]').naturalWidth)).toBe(1);
    expect(await frame.evaluate(() => [...document.styleSheets].some((s) => [...s.cssRules].some((r) => r.cssText.startsWith('@font-face'))))).toBe(true);
    await page.close();
  });
});

describe('the trusted bridge', () => {
  it('runs, and only its messages from exactly the preview window are accepted', async () => {
    const { page } = await open();
    const got = await accepted(page);
    expect(got.map((m) => parsePreviewMessage(m, CHANNEL)?.event)).toContain('ready');
    // The same-origin non-preview frame's forged message was ignored by the source check.
    const ignored = await page.evaluate(() => (window as unknown as { ignored: unknown[] }).ignored);
    expect(ignored).toContainEqual(expect.objectContaining({ markers: { field: IDS.cardTitle } }));
    expect(got.every((m) => parsePreviewMessage(m, CHANNEL) !== null)).toBe(true);
    await page.close();
  });

  it.each([
    ['block', SITE_MODEL_MARKERS.block, IDS.phone, 'field'],
    ['field', SITE_MODEL_MARKERS.field, IDS.cardTitle, 'field'],
    ['asset', SITE_MODEL_MARKERS.asset, IDS.heroImage, 'field'],
  ] as const)('a click inside a %s marker reports the marker chain; precedence resolves it against the model', async (_label, attribute, id, kind) => {
    const { page, frame } = await open();
    const message = await clickMarker(page, frame, attribute, id);
    expect(message?.event).toBe('select');
    const chain = markersOf(message);
    expect(Object.values(chain)).toContain(id);
    expect(selectFromMarkers(view, '/', chain)).toMatchObject({ kind });
    await page.close();
  });

  it('a click on an unmarked part of a section selects the section', async () => {
    const { page, frame } = await open();
    await frame.click('text=About us');
    await page.waitForFunction(() => (window as unknown as { accepted: { event: string }[] }).accepted.some((m) => m.event === 'select'));
    const [message] = await selections(page);
    expect(message!.event === 'select' && message!.markers).toEqual({ section: IDS.services, page: IDS.home });
    expect(selectFromMarkers(view, '/', markersOf(message))).toMatchObject({ kind: 'section', id: IDS.services });
    await page.close();
  });

  it('a click on the page’s own marked element with no inner marker selects the page; nested markers take the field', async () => {
    const { page, frame } = await open();
    await frame.evaluate(() => {
      const main = document.querySelector('[data-statx-page-id]')!;
      const spacer = document.createElement('div');
      spacer.id = 'unmarked';
      spacer.textContent = 'unmarked';
      main.prepend(spacer);
    });
    await frame.click('#unmarked');
    await page.waitForFunction(() => (window as unknown as { accepted: { event: string }[] }).accepted.some((m) => m.event === 'select'));
    const [first] = await selections(page);
    expect(first!.event === 'select' && first!.markers).toEqual({ page: IDS.home });
    expect(selectFromMarkers(view, '/', markersOf(first))).toMatchObject({ kind: 'page', id: IDS.home });
    const nested = await clickMarker(page, frame, SITE_MODEL_MARKERS.field, IDS.imageImage);
    expect(nested!.event === 'select' && nested!.markers).toEqual({ field: IDS.imageImage, asset: IDS.heroImage, block: IDS.image, section: IDS.hero, page: IDS.home });
    expect(selectFromMarkers(view, '/', markersOf(nested))).toMatchObject({ kind: 'field', id: IDS.imageImage });
    await page.close();
  });

  it('a marker the model does not know is reported but selects nothing; an injected foreign ID selects nothing', async () => {
    const { page, frame } = await open();
    await frame.evaluate(() => {
      const el = document.querySelector('[data-statx-field-id]')!;
      el.setAttribute('data-statx-field-id', 'fld_ffffffffffffffff');
    });
    const message = await clickMarker(page, frame, SITE_MODEL_MARKERS.field, 'fld_ffffffffffffffff');
    expect(selectFromMarkers(view, '/', markersOf(message))).toBeNull();
    await page.close();
  });

  it('identity is the marker, not position or text: the same element moved and relabelled reports the same ID', async () => {
    const { page, frame } = await open();
    await frame.evaluate((id) => {
      const card = document.querySelector(`[data-statx-block-id="${id}"]`)!;
      card.querySelector('h3')!.textContent = 'Completely different text';
      document.querySelector('main')!.append(card);
    }, IDS.card);
    const message = await clickMarker(page, frame, SITE_MODEL_MARKERS.field, IDS.cardTitle);
    expect(selectFromMarkers(view, '/', markersOf(message))).toMatchObject({ kind: 'field', id: IDS.cardTitle });
    await page.close();
  });

  it('outlines the object the editor selected, by exact ID', async () => {
    const { page, frame } = await open();
    await page.evaluate(({ type, channel, id }) => {
      document.getElementById('preview').contentWindow.postMessage({ type, version: 1, channel, event: 'highlight', kind: 'section', id }, '*');
    }, { type: PREVIEW_MESSAGE_TYPE, channel: CHANNEL, id: IDS.services });
    await frame.waitForSelector(`[data-statx-section-id="${IDS.services}"][data-statx-editor-selected]`);
    expect(await frame.$$('[data-statx-editor-selected]')).toHaveLength(1);
    await page.close();
  });

  it('a nested route document renders and reports its own page', async () => {
    const { page, frame } = await open('/about');
    const message = await clickMarker(page, frame, SITE_MODEL_MARKERS.field, IDS.aboutIntroHeading);
    expect(selectFromMarkers(view, '/about', markersOf(message))).toMatchObject({ kind: 'field', id: IDS.aboutIntroHeading });
    expect(selectFromMarkers(view, '/', markersOf(message))).toBeNull();
    await page.close();
  });
});
