import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { resolveExportPath, withPreviewPrefix } from '@statxai/workspace';
import { WORKSPACES_ROOT } from '@/lib/store';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
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

  // The static export, not the source. A Next project's source is not
  // servable — index.html there is a shell with an unresolved module script.
  const siteRoot = resolve(WORKSPACES_ROOT, projectId, 'app', 'out');
  const requested = normalize((path ?? []).join('/')).replace(/^(\.\.[/\\])+/, '');

  // Clean URLs resolve the way the deployed host resolves them, so what the
  // preview serves is what the published site serves.
  const resolved = await resolveExportPath(requested === '.' ? '' : requested, async (candidate) => {
    const full = resolve(siteRoot, candidate);
    if (full !== siteRoot && !full.startsWith(siteRoot + sep)) return null;
    const info = await stat(full).catch(() => null);
    return info ? (info.isDirectory() ? 'directory' : 'file') : null;
  });
  if (!resolved) return new Response('Not found', { status: 404 });

  const filePath = join(siteRoot, resolved);
  if (!filePath.startsWith(siteRoot)) return new Response('Forbidden', { status: 403 });

  const body = await readFile(filePath).catch(() => null);
  if (!body) return new Response('Not found', { status: 404 });

  const contentType = TYPES[extname(filePath)] ?? 'application/octet-stream';
  const prefix = `/api/preview/${projectId}`;

  if (contentType.startsWith('text/html') || contentType.startsWith('text/css')) {
    return new Response(withPreviewPrefix(body.toString('utf8'), prefix), {
      headers: { 'content-type': contentType },
    });
  }

  return new Response(new Uint8Array(body), { headers: { 'content-type': contentType } });
}
