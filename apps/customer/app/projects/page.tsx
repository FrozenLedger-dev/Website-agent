import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listCustomerProjects, type CustomerProjectSummary } from '@statxai/customer-editor';
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

export default async function ProjectsPage() {
  const deps = await getCustomerEditorDeps();
  const principal = await currentCustomerPrincipal(deps);
  if (!principal) redirect(loginPathFor('/projects'));
  const projects = await listCustomerProjects(deps.store, principal);

  return (
    <main className="page">
      <header className="page-header">
        <h1>Your projects</h1>
      </header>
      {projects.length === 0 ? (
        <p>You do not have access to any projects yet.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.projectId} className="project-card">
              <div>
                <h2>{project.projectId}</h2>
                <p className="muted">
                  {project.accountName} · {project.role}
                </p>
                <p className={`badge badge-${project.draft}`}>{DRAFT_LABEL[project.draft]}</p>
              </div>
              {project.draft === 'none' ? null : (
                <Link className="button" href={`/projects/${encodeURIComponent(project.projectId)}/editor`}>
                  Open editor
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
