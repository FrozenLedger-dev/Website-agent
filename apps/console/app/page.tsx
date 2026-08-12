import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Link from 'next/link';
import { getStore } from '@/lib/store';
import { LaunchForm } from './launch-form';

export const dynamic = 'force-dynamic';

const EXAMPLE_FALLBACK = JSON.stringify(
  {
    businessName: '',
    industry: '',
    location: '',
    audience: '',
    services: [{ name: '', description: '' }],
    differentiators: [],
    contact: { email: '', phone: '' },
    tone: '',
    goals: [],
  },
  null,
  2,
);

async function loadExample(): Promise<string> {
  for (const candidate of ['examples/intake.json', '../../examples/intake.json']) {
    const text = await readFile(resolve(process.cwd(), candidate), 'utf8').catch(() => null);
    if (text) return text.trimEnd();
  }
  return EXAMPLE_FALLBACK;
}

export default async function Dashboard() {
  const [store, example] = await Promise.all([getStore(), loadExample()]);
  const runs = await store.runs.find({}).sort({ startedAt: -1 }).limit(25).toArray();

  return (
    <div className="grid split">
      <LaunchForm defaultIntake={example} />

      <div className="card">
        <h2>Runs</h2>
        <p className="hint">Every delivery attempt, newest first.</p>

        {runs.length === 0 ? (
          <p className="empty">No runs yet. Start one on the left.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Status</th>
                <th>Phase</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run._id}>
                  <td>
                    <Link href={`/runs/${run._id}`}>{run.businessName}</Link>
                    <div className="mono" style={{ color: 'var(--muted)' }}>
                      {new Date(run.startedAt).toLocaleString()}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${run.status}`}>{run.status}</span>
                  </td>
                  <td className="mono">{run.phase}</td>
                  <td className="mono">{run.status === 'released' ? run.qualityScore : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
