import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WORKSPACES_ROOT } from '@/lib/store';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Serves a generated site so the console can preview it in an iframe. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  const { projectId, path } = await params;

  // projectId comes from the URL. Constrain it to the id format rather than
  // trusting it as a path segment.
  if (!/^proj_[a-z0-9_]+$/.test(projectId)) {
    return new Response('Bad project id', { status: 400 });
  }

  const siteRoot = resolve(WORKSPACES_ROOT, projectId, 'app');
  const requested = normalize((path ?? []).join('/')).replace(/^(\.\.[/\\])+/, '');
  let filePath = requested === '' || requested === '.' ? join(siteRoot, 'index.html') : join(siteRoot, requested);

  if (!filePath.startsWith(siteRoot)) return new Response('Forbidden', { status: 403 });

  const info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) filePath = join(filePath, 'index.html');

  const body = await readFile(filePath).catch(() => null);
  if (!body) return new Response('Not found', { status: 404 });

  const contentType = TYPES[extname(filePath)] ?? 'application/octet-stream';

  // Generated sites use site-root-relative links ("styles.css", "about.html"),
  // but they are served from a nested route. Without a <base>, the browser
  // resolves those against "/api/preview/" — so the stylesheet 404s and the
  // page renders as unstyled text, which is exactly how this shipped before.
  if (contentType.startsWith('text/html')) {
    return new Response(withBaseHref(body.toString('utf8'), `/api/preview/${projectId}/`), {
      headers: { 'content-type': contentType },
    });
  }

  return new Response(new Uint8Array(body), { headers: { 'content-type': contentType } });
}

/** Insert a <base> so site-relative URLs resolve under the preview prefix. */
export function withBaseHref(html: string, base: string): string {
  if (/<base\b/i.test(html)) return html;

  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}<base href="${base}">${html.slice(at)}`;
  }
  // No <head> to anchor to; prepend so it still precedes any resource request.
  return `<base href="${base}">${html}`;
}
