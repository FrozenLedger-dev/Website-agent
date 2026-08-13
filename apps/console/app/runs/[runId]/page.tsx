import { notFound } from 'next/navigation';
import { costOf } from '@statxai/agents';
import { remaining } from '@statxai/state';
import { getStore } from '@/lib/store';
import { RunView } from './run-view';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const store = await getStore();

  const run = await store.runs.findOne({ _id: runId });
  if (!run) notFound();

  const [events, budgets, project, report, review, artifacts] = await Promise.all([
    store.runEvents.find({ runId }).sort({ seq: 1 }).toArray(),
    remaining(store, run.projectId),
    store.projects.findOne({ _id: run.projectId }),
    store.artifacts.findOne({ projectId: run.projectId, name: 'test-report' }, { sort: { version: -1 } }),
    store.artifacts.findOne({ projectId: run.projectId, name: 'visual-review' }, { sort: { version: -1 } }),
    store.artifacts.find({ projectId: run.projectId }).sort({ name: 1, version: 1 }).toArray(),
  ]);

  // Serialised through JSON so Dates cross the server/client boundary cleanly.
  const initial = JSON.parse(
    JSON.stringify({
      run,
      cost: costOf(run.usageByTier ?? {}),
      events,
      budgets,
      projectState: project?.state ?? null,
      testReport: report?.data ?? null,
      review: review?.data ?? null,
      artifacts: artifacts.map((a) => ({
        name: a.name,
        version: a.version,
        accepted: a.acceptedAt !== null,
      })),
    }),
  );

  return <RunView runId={runId} initial={initial} />;
}
