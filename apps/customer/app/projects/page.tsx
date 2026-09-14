import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listCustomerCreateAccounts, listCustomerProjects, type CustomerProjectSummary } from '@statxai/customer-editor';
import { getCustomerEditorDeps } from '../../lib/deps';
import { currentCustomerPrincipal, loginPathFor } from '../../lib/session';

export const dynamic = 'force-dynamic';

const DRAFT_LABEL: Record<CustomerProjectSummary['draft'], string> = {
  none: 'No draft yet',
  ready_to_edit: 'Draft · Ready to edit',
  edit_in_progress: 'Draft · Edit in progress',
  edit_failed: 'Draft · Edit could not be completed',
  busy: 'Draft · Not editable right now',
};

const GENERATION_LABEL: Record<'in_progress' | 'failed', string> = {
  in_progress: 'Generating…',
  failed: 'Generation could not be completed',
};

export default async function ProjectsPage() {
  const deps = await getCustomerEditorDeps();
  const principal = await currentCustomerPrincipal(deps);
  if (!principal) redirect(loginPathFor('/projects'));
  const [projects, createAccounts] = await Promise.all([listCustomerProjects(deps.store, principal), listCustomerCreateAccounts(deps.store, principal)]);
  const canCreate = createAccounts.length > 0;

  return (
    <main className="page">
      <header className="page-header">
        <h1>Your projects</h1>
        {canCreate ? (
          <Link className="button" href="/projects/new">
            + Create website
          </Link>
        ) : null}
      </header>
      {projects.length === 0 ? (
        <div className="empty-state">
          <p>You do not have a website yet.</p>
          {canCreate ? (
            <p>
              <Link className="button" href="/projects/new">
                Create your first website
              </Link>
            </p>
          ) : (
            <p className="muted">Once you&apos;re added to an account, you&apos;ll be able to create one here.</p>
          )}
        </div>
      ) : (
        <ul className="project-list">
          {projects.map((project) => {
            const openHref = project.generation === 'in_progress' ? `/projects/${encodeURIComponent(project.projectId)}/generating` : `/projects/${encodeURIComponent(project.projectId)}/editor`;
            const canOpen = project.draft !== 'none' || project.generation === 'in_progress';
            return (
              <li key={project.projectId} className="project-card">
                <div>
                  <h2>{project.displayName}</h2>
                  <p className="muted">
                    {project.accountName} · {project.role}
                  </p>
                  <p className={`badge badge-${project.generation ?? project.draft}`}>{project.generation ? GENERATION_LABEL[project.generation] : DRAFT_LABEL[project.draft]}</p>
                </div>
                {canOpen ? (
                  <Link className="button" href={openHref}>
                    {project.generation === 'in_progress' ? 'View progress' : 'Open editor'}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
