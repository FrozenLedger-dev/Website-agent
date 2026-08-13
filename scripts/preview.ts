/**
 * Serve a generated site locally (v1.2 §9, preview deployment).
 *
 *   pnpm preview <projectId>
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const projectId = process.argv[2];
if (!projectId) {
  console.error('\n  usage: pnpm preview <projectId>\n');
  process.exit(1);
}

const siteRoot = resolve(process.env.WORKSPACES_ROOT ?? './workspaces', projectId, 'app', 'out');
const port = Number(process.env.PREVIEW_PORT ?? 4173);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  try {
    // Normalise before joining: the request path is attacker-controlled.
    const requested = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(siteRoot, requested);
    if (!filePath.startsWith(siteRoot)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');

    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
}).listen(port, () => {
  console.log(`\n  serving ${siteRoot}`);
  console.log(`  http://localhost:${port}\n`);
});
