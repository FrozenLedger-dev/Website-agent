import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listCustomerCreateAccounts } from '@statxai/customer-editor';
import { getCustomerEditorDeps } from '../../../lib/deps';
import { currentCustomerPrincipal, loginPathFor } from '../../../lib/session';
import { NewProjectForm } from './new-project-form';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  const deps = await getCustomerEditorDeps();
  const principal = await currentCustomerPrincipal(deps);
  if (!principal) redirect(loginPathFor('/projects/new'));

  const accounts = await listCustomerCreateAccounts(deps.store, principal);
  if (accounts.length === 0) {
    return (
      <main className="page narrow">
        <h1>Create a website</h1>
        <p role="status">You do not have permission to create a website in any account yet.</p>
        <p>
          <Link href="/projects">Back to your projects</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="page narrow">
      <h1>Create a website</h1>
      <p className="muted">Tell us about the business. We&apos;ll generate a real first draft — you can refine it afterward.</p>
      <NewProjectForm accounts={accounts} />
    </main>
  );
}
