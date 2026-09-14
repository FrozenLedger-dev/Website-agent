/**
 * The immutable static export of one exact evaluated build.
 *
 * `app/out` is the build's working output: every canonical compile rewrites it,
 * so it describes whichever build compiled last, not any particular revision.
 * A `site-export-snapshot` is the durable answer to "what exactly did this
 * build export?": every regular file of the export, by relative path, stored as
 * content-addressed blobs and listed in a strict manifest bound to the exact
 * build that produced it.
 *
 * It belongs to the build, not to a draft: a draft later names the snapshot of
 * the build it owns. Its `exportDigest` is the same digest the browser render
 * and the screenshot set of that evaluation carry — one meaning, one algorithm.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';
import { BrowserRenderSubject } from './browser.js';

export const SITE_EXPORT_SNAPSHOT_ARTIFACT = 'site-export-snapshot';

/**
 * What one snapshot may hold. A larger export is refused, never truncated.
 *
 * - `maxFileBytes` is exactly the blob store's per-blob limit (12 MiB): one file
 *   is one blob, and a file that cannot be one blob cannot be captured.
 * - `maxFiles` and `maxTotalBytes` sit well above what a generated small-business
 *   site exports (tens of files, low megabytes) and well below what would make a
 *   manifest or a capture unreasonable to hold.
 */
export const SITE_EXPORT_SNAPSHOT_POLICY = Object.freeze({
  version: 'statxai-site-export-snapshot@1',
  maxFiles: 4_096,
  maxFileBytes: 12 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/;

/** Whether a string contains a NUL, a C0 control character or DEL. */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a string is a canonical snapshot path: relative, POSIX, non-empty
 * segments, no `.` or `..`, no backslash, no NUL or control character, no
 * leading or trailing slash.
 */
export function isSiteExportPath(path: string): boolean {
  if (path.length === 0 || path.length > 1_024) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('\\') || hasControlCharacter(path)) return false;
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const SiteExportPath = z.string().refine(isSiteExportPath, 'not a canonical relative export path');

export const SiteExportFile = z.strictObject({
  path: SiteExportPath,
  /** `sha256:<hex>` — the blob-store key; always exactly `sha256:` + `sha256`. */
  blob: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().nonnegative().max(SITE_EXPORT_SNAPSHOT_POLICY.maxFileBytes),
});
export type SiteExportFile = z.infer<typeof SiteExportFile>;

/**
 * What was exported, and on what authority: the render subject's exact plan,
 * source commit and build authority, and the exact editable site model the
 * build pinned (or `null` for a build that predates the model).
 */
export const SiteExportSubject = BrowserRenderSubject.omit({ exportDigest: true }).extend({
  editableSiteModel: ArtifactRef.nullable(),
});
export type SiteExportSubject = z.infer<typeof SiteExportSubject>;

export const SiteExportSnapshot = z
  .strictObject({
    policyVersion: z.literal(SITE_EXPORT_SNAPSHOT_POLICY.version),
    subject: SiteExportSubject,
    /** sha256 over every file's path and sha256, in path order — see `exportDigestOf`. */
    exportDigest: z.string().regex(SHA256),
    files: z.array(SiteExportFile).min(1).max(SITE_EXPORT_SNAPSHOT_POLICY.maxFiles),
    totalFiles: z.number().int().positive(),
    totalBytes: z.number().int().nonnegative().max(SITE_EXPORT_SNAPSHOT_POLICY.maxTotalBytes),
  })
  .superRefine((snapshot, ctx) => {
    for (const [i, file] of snapshot.files.entries()) {
      if (file.blob !== `sha256:${file.sha256}`) ctx.addIssue({ code: 'custom', path: ['files', i, 'blob'], message: 'blob key does not name the file hash' });
      const previous = snapshot.files[i - 1];
      if (previous && !(previous.path < file.path)) ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'paths must be unique and in ascending order' });
    }
    if (snapshot.totalFiles !== snapshot.files.length) ctx.addIssue({ code: 'custom', path: ['totalFiles'], message: 'totalFiles does not count the files' });
    if (snapshot.totalBytes !== snapshot.files.reduce((sum, f) => sum + f.bytes, 0)) ctx.addIssue({ code: 'custom', path: ['totalBytes'], message: 'totalBytes does not sum the files' });
  });
export type SiteExportSnapshot = z.infer<typeof SiteExportSnapshot>;
