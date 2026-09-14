/**
 * The one canonical export digest.
 *
 * sha256 over `path \0 sha256 \n` for every exported file, in ascending path
 * order. The compile, the browser renderer, the screenshot set and the site
 * export snapshot all compute it here and nowhere else, so an export's digest
 * has exactly one meaning. Pure: Node's hash and nothing else.
 */
import { createHash } from 'node:crypto';

export function exportDigestOf(entries: readonly { readonly path: string; readonly sha256: string }[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256');
  for (const entry of sorted) digest.update(`${entry.path}\0${entry.sha256}\n`);
  return digest.digest('hex');
}
