/**
 * Serving a static export from a nested route.
 *
 * The console previews at `/api/preview/<projectId>/`. A Next export addresses
 * everything from the origin root, so every asset resolves to a console 404 and
 * the page renders as unstyled black text on white — which is how the preview
 * shipped, twice. The first fix was a `<base href>`, which only affects
 * *relative* URLs; after the move to Next there are none left.
 */
import { describe, expect, it } from 'vitest';
import { resolveExportPath, withPreviewPrefix } from '../src/preview.js';

const PREFIX = '/api/preview/proj_test';

describe('withPreviewPrefix', () => {
  it('prefixes the stylesheet, without which the page renders unstyled', () => {
    const html = '<link rel="stylesheet" href="/_next/static/chunks/site.css">';
    expect(withPreviewPrefix(html, PREFIX)).toBe(
      '<link rel="stylesheet" href="/api/preview/proj_test/_next/static/chunks/site.css">',
    );
  });

  it('prefixes scripts, so hydration completes and interactive parts work', () => {
    const html = '<script src="/_next/static/chunks/turbopack.js" async></script>';
    expect(withPreviewPrefix(html, PREFIX)).toContain('src="/api/preview/proj_test/_next/');
  });

  it('prefixes internal navigation', () => {
    expect(withPreviewPrefix('<a href="/services">Services</a>', PREFIX)).toBe(
      '<a href="/api/preview/proj_test/services">Services</a>',
    );
  });

  it('prefixes chunk paths inside the inlined router payload', () => {
    const html = '<script>self.__next_f.push([1,"/_next/static/chunks/app.js"])</script>';
    expect(withPreviewPrefix(html, PREFIX)).toContain('"/api/preview/proj_test/_next/static/chunks/app.js"');
  });

  it('prefixes url() in CSS, so fonts and background images load', () => {
    const css = '@font-face{src:url(/_next/static/media/inter.woff2) format("woff2")}';
    expect(withPreviewPrefix(css, PREFIX)).toContain('url(/api/preview/proj_test/_next/static/media/inter.woff2)');
  });

  it('leaves external and scheme URLs alone', () => {
    const html =
      '<a href="https://example.com/x">x</a><a href="mailto:a@b.co">m</a>' +
      '<a href="tel:+441234567890">t</a><a href="//cdn.example.com/y">y</a><a href="#hero">h</a>';
    expect(withPreviewPrefix(html, PREFIX)).toBe(html);
  });

  it('leaves prose alone', () => {
    // The rewrite touches URLs in attribute and url() positions only. A slash in
    // a sentence is not a path.
    const html = '<p>Open 9/5, Monday to Friday. Call us on 01423 887 214.</p>';
    expect(withPreviewPrefix(html, PREFIX)).toBe(html);
  });

  it('is idempotent, so a double pass cannot double-prefix', () => {
    const html = '<link rel="stylesheet" href="/_next/static/chunks/site.css"><a href="/services">s</a>';
    const once = withPreviewPrefix(html, PREFIX);
    expect(withPreviewPrefix(once, PREFIX)).toBe(once);
  });
});

describe('resolveExportPath', () => {
  /** A real export: every route is a file, and also a directory of payloads. */
  const EXPORT = new Set([
    'index.html',
    'services.html',
    'about.html',
    'services/__next._tree.txt',
    'about/__next._tree.txt',
    '_next/static/chunks/site.css',
  ]);

  const exists = (path: string): Promise<'file' | 'directory' | null> =>
    Promise.resolve(
      EXPORT.has(path) ? 'file' : [...EXPORT].some((p) => p.startsWith(`${path}/`)) ? 'directory' : null,
    );

  it('serves the sibling .html rather than the same-named directory', async () => {
    // Regression: `services/` exists and holds only the router's payload files,
    // so a directory-first resolution 404s on a page sitting right beside it.
    expect(await resolveExportPath('/services', exists)).toBe('services.html');
  });

  it('serves the homepage for the root', async () => {
    expect(await resolveExportPath('', exists)).toBe('index.html');
    expect(await resolveExportPath('/', exists)).toBe('index.html');
  });

  it('serves an asset by its exact path', async () => {
    expect(await resolveExportPath('_next/static/chunks/site.css', exists)).toBe('_next/static/chunks/site.css');
  });

  it('returns null for a route the export does not contain', async () => {
    expect(await resolveExportPath('/pricing', exists)).toBeNull();
  });

  it('falls back to a directory index when one genuinely exists', async () => {
    const nested = (path: string): Promise<'file' | 'directory' | null> =>
      Promise.resolve(path === 'blog/index.html' ? 'file' : path === 'blog' ? 'directory' : null);
    expect(await resolveExportPath('/blog', nested)).toBe('blog/index.html');
  });
});
