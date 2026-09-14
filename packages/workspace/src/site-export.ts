/**
 * Immutable site export snapshots: capture, exact reading, and request
 * resolution.
 *
 * Capture reads one export directory exactly once — regular files only, under
 * explicit bounds, refusing anything else — digests those bytes with the one
 * canonical export digest, and refuses unless that digest is the one the caller
 * already holds for the export (the compile's own digest of what it wrote), so a
 * directory another writer touched in between is refused rather than captured.
 * Blobs are written first, then the manifest artifact: a failure can leave
 * deduplicated, unreferenced blobs, never a manifest naming a missing one.
 *
 * Reading is by exact artifact ref only: the stored document's content hash, the
 * manifest's own invariants and digest, and every blob's hash are re-proven.
 * Request resolution maps a URL path onto the manifest alone — never a
 * filesystem — the way the deployed host resolves clean URLs.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  SITE_EXPORT_SNAPSHOT_ARTIFACT,
  SITE_EXPORT_SNAPSHOT_POLICY,
  SiteExportSnapshot,
  hasControlCharacter,
  isSiteExportPath,
  type ArtifactRef,
  type SiteExportSubject,
} from '@statxai/contracts';
import type { ArtifactRegistry } from './registry.js';
import { MAX_BLOB_BYTES, type BlobStore } from './blob-store.js';
import { resolveExportPath } from './preview.js';
import { exportDigestOf } from './export-digest.js';

/** Every snapshot file is one blob of this type; how to serve it is decided from its trusted path, not from storage. */
export const SITE_EXPORT_BLOB_CONTENT_TYPE = 'application/octet-stream';

export { exportDigestOf } from './export-digest.js';

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SiteExportSnapshotRefusal = 'empty_export' | 'too_many_files' | 'file_too_large' | 'snapshot_too_large' | 'invalid_entry' | 'export_changed';

/** The export cannot be captured as a snapshot. Nothing was recorded; nothing was truncated. */
export class SiteExportSnapshotRefused extends Error {
  constructor(
    readonly reason: SiteExportSnapshotRefusal,
    detail: string,
  ) {
    super(`site export snapshot refused (${reason}): ${detail}`);
    this.name = 'SiteExportSnapshotRefused';
  }
}

/** A stored snapshot does not prove itself. */
export class SiteExportSnapshotInvalid extends Error {
  constructor(ref: ArtifactRef, detail: string) {
    super(`${ref.name}@${ref.version} is not a valid site export snapshot: ${detail}`);
    this.name = 'SiteExportSnapshotInvalid';
  }
}

/** A requested path is not a path this snapshot can be asked for. */
export class SiteExportPathRejected extends Error {
  constructor(detail: string) {
    super(`site export path rejected: ${detail}`);
    this.name = 'SiteExportPathRejected';
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface ExportTreeFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Read every regular file of an export directory exactly once, bounded.
 * Directories are walked; symlinks, sockets, FIFOs, devices and anything else
 * are refused, never followed or skipped.
 */
export async function readExportTree(
  exportDir: string,
  /** Tighter bounds for this read — never looser than the policy's. */
  limits: { readonly maxFiles?: number; readonly maxFileBytes?: number; readonly maxTotalBytes?: number } = {},
): Promise<{ files: ExportTreeFile[]; exportDigest: string; totalBytes: number }> {
  const base = SITE_EXPORT_SNAPSHOT_POLICY;
  const policy = {
    maxFiles: Math.min(base.maxFiles, limits.maxFiles ?? base.maxFiles),
    maxFileBytes: Math.min(base.maxFileBytes, limits.maxFileBytes ?? base.maxFileBytes),
    maxTotalBytes: Math.min(base.maxTotalBytes, limits.maxTotalBytes ?? base.maxTotalBytes),
  };
  const files: ExportTreeFile[] = [];
  let totalBytes = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(full);
      if (info.isDirectory()) {
        await walk(full, path);
        continue;
      }
      if (!info.isFile()) throw new SiteExportSnapshotRefused('invalid_entry', `${path} is not a regular file`);
      if (!isSiteExportPath(path)) throw new SiteExportSnapshotRefused('invalid_entry', `${JSON.stringify(path)} is not a canonical export path`);
      if (files.length + 1 > policy.maxFiles) throw new SiteExportSnapshotRefused('too_many_files', `more than ${policy.maxFiles} files`);
      if (info.size > policy.maxFileBytes) throw new SiteExportSnapshotRefused('file_too_large', `${path} is ${info.size} bytes, over ${policy.maxFileBytes}`);
      const bytes = await readFile(full);
      if (bytes.length > policy.maxFileBytes) throw new SiteExportSnapshotRefused('file_too_large', `${path} is ${bytes.length} bytes, over ${policy.maxFileBytes}`);
      totalBytes += bytes.length;
      if (totalBytes > policy.maxTotalBytes) throw new SiteExportSnapshotRefused('snapshot_too_large', `the export exceeds ${policy.maxTotalBytes} bytes`);
      files.push({ path, bytes, sha256: sha256Of(bytes) });
    }
  };

  const root = await lstat(exportDir).catch(() => null);
  if (!root) throw new SiteExportSnapshotRefused('empty_export', 'there is no export directory');
  if (!root.isDirectory()) throw new SiteExportSnapshotRefused('invalid_entry', 'the export root is not a directory');
  await walk(exportDir, '');
  if (files.length === 0) throw new SiteExportSnapshotRefused('empty_export', 'the export has no files');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, exportDigest: exportDigestOf(files), totalBytes };
}

export interface CapturedSiteExportSnapshot {
  readonly ref: ArtifactRef;
  readonly snapshot: SiteExportSnapshot;
  /** The captured bytes, by path — what a renderer of this exact snapshot is given. */
  readonly files: readonly ExportTreeFile[];
}

/**
 * Capture one export directory as an immutable snapshot of one exact build.
 *
 * `expectedExportDigest` is the digest the caller already holds for this export
 * — the compile's own digest of the files it wrote. A directory that no longer
 * digests to it is refused (`export_changed`).
 */
export async function captureSiteExportSnapshot(input: {
  readonly registry: ArtifactRegistry;
  readonly blobs: BlobStore;
  readonly projectId: string;
  readonly exportDir: string;
  readonly subject: SiteExportSubject;
  readonly expectedExportDigest: string;
}): Promise<CapturedSiteExportSnapshot> {
  if (SITE_EXPORT_SNAPSHOT_POLICY.maxFileBytes !== MAX_BLOB_BYTES) throw new Error('site export policy and blob store disagree on the per-file limit');
  if (input.subject.projectId !== input.projectId) throw new Error(`a snapshot for "${input.subject.projectId}" cannot be recorded under "${input.projectId}"`);

  const tree = await readExportTree(input.exportDir);
  if (tree.exportDigest !== input.expectedExportDigest) {
    throw new SiteExportSnapshotRefused('export_changed', `the export digests to ${tree.exportDigest}, not the ${input.expectedExportDigest} the build produced`);
  }

  // Blobs first: a manifest never names a blob that was not durably written.
  const files = [];
  for (const file of tree.files) {
    const stored = await input.blobs.put(file.bytes, SITE_EXPORT_BLOB_CONTENT_TYPE);
    files.push({ path: file.path, blob: stored.blob, sha256: stored.sha256, bytes: stored.bytes });
  }
  const snapshot = SiteExportSnapshot.parse({
    policyVersion: SITE_EXPORT_SNAPSHOT_POLICY.version,
    subject: input.subject,
    exportDigest: tree.exportDigest,
    files,
    totalFiles: files.length,
    totalBytes: tree.totalBytes,
  });
  const ref = await input.registry.put(input.projectId, SITE_EXPORT_SNAPSHOT_ARTIFACT, snapshot);
  return { ref, snapshot, files: tree.files };
}

/** Write captured bytes into a fresh directory — a renderer's exact, private copy. */
export async function materializeSiteExport(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    if (!isSiteExportPath(file.path)) throw new SiteExportPathRejected(`${JSON.stringify(file.path)} is not a canonical export path`);
    const target = join(dir, ...file.path.split('/'));
    if (!target.startsWith(dir + sep)) throw new SiteExportPathRejected(`${file.path} escapes the export`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

// ---------------------------------------------------------------------------
// Exact reading
// ---------------------------------------------------------------------------

/**
 * The snapshot an exact ref names, fully re-proven: the ref's name and content
 * hash, the stored document's hash, the manifest's schema and invariants, its
 * project, and its digest recomputed from its own entries. Never "the latest".
 */
export async function readSiteExportSnapshot(registry: ArtifactRegistry, projectId: string, ref: ArtifactRef): Promise<SiteExportSnapshot> {
  if (ref.name !== SITE_EXPORT_SNAPSHOT_ARTIFACT) throw new SiteExportSnapshotInvalid(ref, 'not a site-export-snapshot ref');
  if (!ref.contentHash) throw new SiteExportSnapshotInvalid(ref, 'the ref carries no content hash');
  const doc = await registry.getDocument(projectId, ref);
  if (!doc) throw new SiteExportSnapshotInvalid(ref, 'no such version');
  if (doc.contentHash !== ref.contentHash) throw new SiteExportSnapshotInvalid(ref, 'the stored content does not match the ref');
  const parsed = SiteExportSnapshot.safeParse(doc.data);
  if (!parsed.success) throw new SiteExportSnapshotInvalid(ref, 'the stored manifest is malformed');
  if (parsed.data.subject.projectId !== projectId) throw new SiteExportSnapshotInvalid(ref, 'it belongs to another project');
  if (exportDigestOf(parsed.data.files) !== parsed.data.exportDigest) throw new SiteExportSnapshotInvalid(ref, 'the manifest does not digest to its exportDigest');
  return parsed.data;
}

/** One file of an exact snapshot, by its exact manifest path, re-hashed on read. `null` when the manifest has no such path. */
export async function readSiteExportFile(blobs: BlobStore, snapshot: SiteExportSnapshot, path: string): Promise<{ path: string; bytes: Buffer; contentType: string } | null> {
  const file = snapshot.files.find((f) => f.path === path);
  if (!file) return null;
  const bytes = await blobs.get(file.blob);
  if (bytes.length !== file.bytes || sha256Of(bytes) !== file.sha256) throw new Error(`snapshot file ${path} does not match its manifest entry`);
  return { path, bytes, contentType: siteExportContentType(path) };
}

// ---------------------------------------------------------------------------
// Request resolution
// ---------------------------------------------------------------------------

/**
 * A request path — raw, possibly percent-encoded, as segments or a string —
 * decoded once and validated as a site path, or refused. The empty path is the
 * site root.
 */
export function normalizeSiteExportRequest(raw: string | readonly string[]): string {
  const joined = typeof raw === 'string' ? raw : raw.join('/');
  let decoded: string;
  try {
    decoded = decodeURIComponent(joined);
  } catch {
    throw new SiteExportPathRejected('malformed percent-encoding');
  }
  if (hasControlCharacter(decoded)) throw new SiteExportPathRejected('control characters');
  if (decoded.includes('\\')) throw new SiteExportPathRejected('backslashes are ambiguous');
  if (decoded.startsWith('/') && typeof raw !== 'string') throw new SiteExportPathRejected('absolute paths');
  const trimmed = decoded.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) throw new SiteExportPathRejected('dot or empty segments');
  if (!isSiteExportPath(trimmed)) throw new SiteExportPathRejected('not a site path');
  return trimmed;
}

/**
 * The manifest path a request resolves to, the way the deployed host resolves a
 * static Next export — `/` is `index.html`, an extensionless route prefers its
 * `.html` sibling, then its `index.html` — or `null` when the snapshot has
 * nothing there. Consults the manifest only.
 */
export async function resolveSiteExportRequest(snapshot: SiteExportSnapshot, raw: string | readonly string[]): Promise<string | null> {
  const requested = normalizeSiteExportRequest(raw);
  const paths = new Set(snapshot.files.map((f) => f.path));
  return resolveExportPath(requested, async (candidate) => {
    if (paths.has(candidate)) return 'file';
    const prefix = `${candidate}/`;
    for (const path of paths) if (path.startsWith(prefix)) return 'directory';
    return null;
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
});

/** The media type of a snapshot path, from its extension alone; anything unknown is opaque bytes. */
export function siteExportContentType(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return (match && CONTENT_TYPES[match[1]!.toLowerCase()]) ?? 'application/octet-stream';
}
