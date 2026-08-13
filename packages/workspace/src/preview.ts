/**
 * Serving a static export from somewhere other than the origin root.
 *
 * The console previews a generated site under `/api/preview/<projectId>/`, but
 * the export addresses everything from the root because that is where it will
 * be deployed. Reconciling the two is a string transformation on the way out,
 * not a build-time setting — the deployed artifact must stay unprefixed.
 */

/**
 * Resolve a clean URL against a static export, the way a host's `cleanUrls` does.
 *
 * Returns the export-relative file for a request path, or null when nothing
 * matches. Split out from the console's route handler because the interesting
 * case is not obvious and is worth pinning: the export writes "/services" as
 * `services.html` **and** creates a `services/` directory holding the router's
 * payload files. The directory exists and has no `index.html`, so resolving
 * directory-first serves a 404 while the real page sits beside it.
 */
export type ExportEntry = 'file' | 'directory' | null;

export async function resolveExportPath(
  requested: string,
  exists: (path: string) => Promise<ExportEntry>,
): Promise<string | null> {
  const path = requested.replace(/^\/+|\/+$/g, '');
  if (path === '') return (await exists('index.html')) === 'file' ? 'index.html' : null;

  const direct = await exists(path);
  if (direct === 'file') return path;

  // Extensionless: the sibling .html wins over a same-named directory.
  if (!/\.[a-z0-9]+$/i.test(path) && (await exists(`${path}.html`)) === 'file') return `${path}.html`;

  if (direct === 'directory' && (await exists(`${path}/index.html`)) === 'file') return `${path}/index.html`;
  return null;
}


/**
 * Rewrite the export's root-absolute URLs to sit under the preview prefix.
 *
 * A static Next export addresses everything from the origin root —
 * `/_next/static/…`, `/favicon.ico`, `/services` — because that is where it will
 * be deployed. The console serves it from a nested route instead, so every one
 * of those resolves to a console 404: the stylesheet does not load and the page
 * renders as unstyled black text on white.
 *
 * A `<base href>` does not fix this. `<base>` only affects *relative* URLs, and
 * after the move to Next there are none left — which is why the previous fix
 * stopped working the moment the generated stack changed.
 *
 * Deliberately not a general HTML rewriter: it touches URLs in the positions an
 * export actually uses, and leaves prose alone. `//host` is skipped so
 * protocol-relative externals survive; `/api/preview/` is skipped so the rewrite
 * is idempotent.
 */
export function withPreviewPrefix(text: string, prefix: string): string {
  const absolute = String.raw`/(?!/|api/preview/)`;

  return (
    text
      // href="/x", src='/x', action="/x" — the attributes an export emits.
      .replace(
        new RegExp(String.raw`\b(href|src|action|poster)=(["'])${absolute}`, 'gi'),
        (_m, attr: string, quote: string) => `${attr}=${quote}${prefix}/`,
      )
      // srcset="/a 1x, /b 2x" — each candidate is its own URL.
      .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_m, quote: string, value: string) => {
        const rewritten = value.replace(/(^|,\s*)\/(?!\/|api\/preview\/)/g, `$1${prefix}/`);
        return `srcset=${quote}${rewritten}${quote}`;
      })
      // url(/x) in CSS, and the same inside a style attribute.
      .replace(
        new RegExp(String.raw`url\((\s*["']?)${absolute}`, 'gi'),
        (_m, open: string) => `url(${open}${prefix}/`,
      )
      // "/_next/…" inside the inlined router payload. Without this the client
      // requests its chunks from the console root and hydration never completes,
      // so nothing interactive works.
      .replace(/(["'])\/_next\//g, `$1${prefix}/_next/`)
  );
}
