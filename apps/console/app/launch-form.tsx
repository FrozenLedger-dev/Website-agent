'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const MODES = [
  ['full_autonomous', 'Full Autonomous — machine approval, no human gate'],
  ['supervised_autonomous', 'Supervised — human engaged on exceptions'],
  ['human_in_the_loop', 'Human-in-the-Loop — explicit approval required'],
] as const;

export function LaunchForm({ defaultIntake }: { defaultIntake: string }) {
  const router = useRouter();
  const [intake, setIntake] = useState(defaultIntake);
  const [mode, setMode] = useState<string>('full_autonomous');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(intake);
    } catch {
      setError('Intake is not valid JSON.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intake: parsed, autonomyMode: mode }),
      });
      const body = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !body.runId) {
        setError(body.error ?? 'Failed to start the run.');
        return;
      }
      router.push(`/runs/${body.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>New project</h2>
      <p className="hint">
        Intake is validated against the canonical business profile before any tokens are spent. A
        profile that is too thin to build from is rejected here rather than producing invented copy.
      </p>

      <label className="field" htmlFor="intake">
        Business profile (JSON)
      </label>
      <textarea id="intake" value={intake} onChange={(e) => setIntake(e.target.value)} spellCheck={false} />

      <div className="row" style={{ marginTop: 14 }}>
        <div>
          <label className="field" htmlFor="mode">
            Autonomy mode
          </label>
          <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button onClick={launch} disabled={busy}>
          {busy ? 'Starting…' : 'Run project'}
        </button>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
