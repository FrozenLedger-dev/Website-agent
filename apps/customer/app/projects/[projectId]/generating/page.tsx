import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { readCustomerGenerationStatus } from '@statxai/customer-editor';
import { getCustomerEditorDeps } from '../../../../lib/deps';
import { currentCustomerPrincipal, loginPathFor } from '../../../../lib/session';
import { GeneratingStatus } from './generating-status';

export const dynamic = 'force-dynamic';

export default async function GeneratingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const deps = await getCustomerEditorDeps();
  const principal = await currentCustomerPrincipal(deps);
  if (!principal) redirect(loginPathFor(`/projects/${encodeURIComponent(projectId)}/generating`));

  const status = await readCustomerGenerationStatus(deps.store, principal, projectId);
  if (!status.ok) notFound();
  // A fast path for a page load that lands after generation already finished —
  // the client component below still re-checks before ever navigating on its
  // own, so this is an optimisation, never the proof.
  if (status.status.state === 'completed') redirect(`/projects/${encodeURIComponent(projectId)}/editor`);

  return (
    <main className="page narrow">
      <h1>Generating your website</h1>
      <p className="muted">This can take a few minutes. You can leave this page and come back — nothing here is lost.</p>
      <GeneratingStatus projectId={projectId} initialStatus={status.status} />
      <p>
        <Link href="/projects">Back to your projects</Link>
      </p>
    </main>
  );
}
