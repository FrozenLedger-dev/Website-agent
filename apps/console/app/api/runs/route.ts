import { NextResponse } from 'next/server';
import { ActiveJobLifecycleRollbackConflict, launchRun } from '@statxai/orchestrator';
import { FRONTEND_BACKEND_EXECUTION_MODE, VALIDATION_WORKSPACES_ROOT, getStore, WORKSPACES_ROOT } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const store = await getStore();
  const runs = await store.runs.find({}).sort({ startedAt: -1 }).limit(50).toArray();
  return NextResponse.json({ runs });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { intake?: unknown; autonomyMode?: string };

  if (!body.intake || typeof body.intake !== 'object') {
    return NextResponse.json({ error: 'Provide an intake object.' }, { status: 400 });
  }

  const store = await getStore();

  // Phase 5l: the one production entrypoint that opts into `job_lifecycle`.
  // The mode comes entirely from this process's own configuration
  // (`FRONTEND_BACKEND_EXECUTION_MODE`, resolved once at module load) — never
  // from `body`, so intake content can never select a build authority.
  let handle;
  try {
    handle = await launchRun({
      store,
      intake: body.intake,
      workspacesRoot: WORKSPACES_ROOT,
      validationWorkspacesRoot: VALIDATION_WORKSPACES_ROOT,
      frontendBackendExecutionMode: FRONTEND_BACKEND_EXECUTION_MODE,
      autonomyMode: (body.autonomyMode as 'full_autonomous') ?? 'full_autonomous',
    });
  } catch (error) {
    if (error instanceof ActiveJobLifecycleRollbackConflict) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  // Deliberately not awaited: a run takes minutes. The client follows progress
  // through the run record instead of holding this request open.
  void handle.completed;

  return NextResponse.json({ runId: handle.runId, projectId: handle.projectId });
}
