/**
 * A static export that carries an editable site model's identity exactly —
 * for suites that fake the compiler, so the real site-model gate still runs
 * against what a faithful build would export.
 *
 * Test support only. Choosing "the newest model" is how a fake compiler knows
 * which model the run just asked for; no production path ever does this.
 */
import { EDITABLE_SITE_MODEL_ARTIFACT, EditableSiteModel, SITE_MODEL_MARKERS, routeToOutputPath, routeToSourcePath } from '@statxai/contracts';
import type { StateStore } from '@statxai/state';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One HTML file per page, with every visible section, heading, block and field marked exactly as the model says. */
export function exportForModel(model: EditableSiteModel, options: { readonly body?: string } = {}): { path: string; contents: string }[] {
  return model.pages.map((page) => {
    const value = (key: string) => String(page.fields.find((f) => f.key === key)!.value);
    const sections = page.sections
      .filter((section) => section.visibility === 'visible')
      .map((section) => {
        const heading = section.fields.find((f) => f.key === 'heading')!;
        const blocks = section.blocks
          .filter((block) => block.visibility === 'visible')
          .map((block) => {
            const fields = block.fields
              .map((field) =>
                field.type === 'cta'
                  ? `<a ${SITE_MODEL_MARKERS.field}="${field.fieldId}" href="${escape(field.value.href)}">${escape(field.value.label)}</a>`
                  : field.type === 'asset'
                    ? `<img ${SITE_MODEL_MARKERS.field}="${field.fieldId}" ${SITE_MODEL_MARKERS.asset}="${field.value}" alt="">`
                    : `<p ${SITE_MODEL_MARKERS.field}="${field.fieldId}">${escape(field.value)}</p>`,
              )
              .join('');
            return `<div ${SITE_MODEL_MARKERS.block}="${block.blockId}">${fields}</div>`;
          })
          .join('');
        return `<section ${SITE_MODEL_MARKERS.section}="${section.sectionId}"><h2 ${SITE_MODEL_MARKERS.field}="${heading.fieldId}">${escape(String(heading.value))}</h2>${blocks}</section>`;
      })
      .join('');
    return {
      path: routeToOutputPath(page.route),
      contents: `<!doctype html><html lang="en"><head><title>${escape(value('title'))}</title><meta name="description" content="${escape(value('description'))}"></head><body>${options.body ?? ''}<main ${SITE_MODEL_MARKERS.page}="${page.pageId}">${sections}</main></body></html>`,
    };
  });
}

/** The newest recorded model of one project in the test store, or null when the run has none (legacy_direct). */
export async function newestModelInStore(store: StateStore, projectId: string): Promise<EditableSiteModel | null> {
  const doc = await store.artifacts.find({ projectId, name: EDITABLE_SITE_MODEL_ARTIFACT }).sort({ lineageSeq: -1 }).limit(1).next();
  return doc ? EditableSiteModel.parse(doc.data) : null;
}

/**
 * What a faked compiler exports for the site it was asked to build: that project's
 * newest model's marked pages, or the suite's own fallback when it has no model.
 * Every workspace — canonical or disposable validation — keeps its site at `<root>/<projectId>/app`.
 */
export async function fakeExport(
  store: StateStore,
  siteRoot: string,
  fallback: { path: string; contents: string }[],
  body?: string,
): Promise<{ path: string; contents: string }[]> {
  const model = await newestModelInStore(store, basename(dirname(siteRoot)));
  return model ? [...exportForModel(model, body !== undefined ? { body } : {}), ...fallback.filter((f) => !model.pages.some((p) => routeToOutputPath(p.route) === f.path))] : fallback;
}

/** Page files whose contents are that page's exported HTML, so a faked compiler exports exactly what a build wrote. */
export function pageFilesForModel(model: EditableSiteModel, body: string, tamper?: (html: string, route: string) => string): { path: string; contents: string }[] {
  return exportForModel(model, { body }).map((file) => {
    const page = model.pages.find((p) => routeToOutputPath(p.route) === file.path)!;
    return { path: routeToSourcePath(page.route), contents: tamper ? tamper(file.contents, page.route) : file.contents };
  });
}

/** A faked compiler that reads every `app/**\/page.tsx` of a site root as that route's exported HTML. */
export async function exportFromPageFiles(siteRoot: string): Promise<{ path: string; contents: string }[]> {
  const out: { path: string; contents: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'page.tsx') {
        const route = `/${relative(join(siteRoot, 'app'), dir)}`.replace(/\/$/, '');
        out.push({ path: routeToOutputPath(route === '' ? '/' : route), contents: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(join(siteRoot, 'app'));
  return out;
}
