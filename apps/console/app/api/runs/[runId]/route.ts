import { NextResponse } from 'next/server';
import { remaining } from '@statxai/state';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const store = await getStore();

  const run = await store.runs.findOne({ _id: runId });
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const since = Number(new URL(request.url).searchParams.get('since') ?? 0);
  const events = await store.runEvents
    .find({ runId, seq: { $gt: since } })
    .sort({ seq: 1 })
    .toArray();

  const [budgets, project, report, review, artifacts] = await Promise.all([
    remaining(store, run.projectId),
    store.projects.findOne({ _id: run.projectId }),
    store.artifacts.findOne({ projectId: run.projectId, name: 'test-report' }, { sort: { version: -1 } }),
    store.artifacts.findOne({ projectId: run.projectId, name: 'visual-review' }, { sort: { version: -1 } }),
    store.artifacts.find({ projectId: run.projectId }).sort({ name: 1, version: 1 }).toArray(),
  ]);

  return NextResponse.json({
    run,
    events,
    budgets,
    projectState: project?.state ?? null,
    testReport: report?.data ?? null,
    review: review?.data ?? null,
    artifacts: artifacts.map((a) => ({ name: a.name, version: a.version, accepted: a.acceptedAt !== null })),
  });
}
