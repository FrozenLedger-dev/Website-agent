import { NextResponse } from 'next/server';
import { launchRun } from '@statxai/orchestrator';
import { getStore, WORKSPACES_ROOT } from '@/lib/store';

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
  const handle = await launchRun({
    store,
    intake: body.intake,
    workspacesRoot: WORKSPACES_ROOT,
    autonomyMode: (body.autonomyMode as 'full_autonomous') ?? 'full_autonomous',
  });

  // Deliberately not awaited: a run takes minutes. The client follows progress
  // through the run record instead of holding this request open.
  void handle.completed;

  return NextResponse.json({ runId: handle.runId, projectId: handle.projectId });
}
