import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadCustomerEditorState } from '@statxai/customer-editor';
import { getCustomerEditorDeps } from '../../../../lib/deps';
import { currentCustomerPrincipal, loginPathFor } from '../../../../lib/session';
import { Editor } from './editor';

export const dynamic = 'force-dynamic';

export default async function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const deps = await getCustomerEditorDeps();
  const principal = await currentCustomerPrincipal(deps);
  if (!principal) redirect(loginPathFor(`/projects/${encodeURIComponent(projectId)}/editor`));

  // The one editor-state loader; the browser receives only its bounded state.
  const load = await loadCustomerEditorState(deps.store, principal, projectId);
  if (!load.ok) notFound();

  if (load.state.kind === 'unavailable') {
    return (
      <main className="page narrow">
        <h1>{projectId}</h1>
        <p role="status">
          {load.state.unavailable === 'no_draft'
            ? 'This project does not have a draft to edit yet.'
            : 'This draft cannot be opened in the editor right now.'}
        </p>
        <p>
          <Link href="/projects">Back to your projects</Link>
        </p>
      </main>
    );
  }
  return <Editor initialState={load.state} />;
}
