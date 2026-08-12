'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface RunEvent {
  seq: number;
  phase: string;
  detail: string;
  level: 'info' | 'warn' | 'ok' | 'fail';
}

interface Finding {
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  location: string;
  message?: string;
  reason?: string;
  gate?: string;
  category?: string;
  acceptanceTest: string;
}

interface Snapshot {
  run: {
    _id: string;
    projectId: string;
    businessName: string;
    autonomyMode: string;
    status: string;
    phase: string;
    qualityScore: number;
    reviewCycles: number;
    repairsApplied: number;
    commit: string | null;
    error: string | null;
    usage: { inputTokens: number; outputTokens: number; calls: number };
    startedAt: string;
    finishedAt: string | null;
  };
  events: RunEvent[];
  budgets: Record<string, number> | null;
  projectState: string | null;
  testReport: { findings: Finding[]; gatesRun: string[] } | null;
  review: { issues: Finding[]; qualityScore: number; decision: string } | null;
  artifacts: { name: string; version: number; accepted: boolean }[];
}

const LIMITS: Record<string, number> = {
  reviewRejections: 3,
  totalRepairJobs: 8,
  fullRebuilds: 1,
  replans: 2,
  failedDeployments: 2,
};

export function RunView({ runId, initial }: { runId: string; initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [events, setEvents] = useState<RunEvent[]>(initial.events);
  const timeline = useRef<HTMLUListElement>(null);

  const live = snap.run.status === 'running';

  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    const tick = async () => {
      const since = events.length > 0 ? events[events.length - 1]!.seq : 0;
      const res = await fetch(`/api/runs/${runId}?since=${since}`, { cache: 'no-store' }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const next = (await res.json()) as Snapshot;
      setSnap(next);
      if (next.events.length > 0) setEvents((prev) => [...prev, ...next.events]);
    };

    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, runId, events]);

  useEffect(() => {
    timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [events.length]);

  const { run } = snap;
  const elapsed = Math.round(
    ((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) -
      new Date(run.startedAt).getTime()) /
      1000,
  );

  const gateFindings = snap.testReport?.findings ?? [];
  const reviewFindings = snap.review?.issues ?? [];

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: 16 }}>
          <div style={{ flex: '1 1 auto' }}>
            <h2 style={{ marginBottom: 2 }}>{run.businessName}</h2>
            <div className="mono" style={{ color: 'var(--muted)' }}>
              {run.projectId} · {run.autonomyMode}
            </div>
          </div>
          <span className={`pill ${run.status}`} style={{ flex: '0 0 auto' }}>
            {live ? `${run.phase}…` : run.status}
          </span>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="k">Quality</div>
            <div className="v">{run.status === 'released' ? run.qualityScore : '—'}</div>
          </div>
          <div className="stat">
            <div className="k">Review cycles</div>
            <div className="v">{run.reviewCycles}</div>
          </div>
          <div className="stat">
            <div className="k">Repairs</div>
            <div className="v">{run.repairsApplied}</div>
          </div>
          <div className="stat">
            <div className="k">Tokens out</div>
            <div className="v">{run.usage.outputTokens.toLocaleString()}</div>
          </div>
          <div className="stat">
            <div className="k">Model calls</div>
            <div className="v">{run.usage.calls}</div>
          </div>
          <div className="stat">
            <div className="k">Elapsed</div>
            <div className="v">{elapsed}s</div>
          </div>
        </div>

        {run.error ? <p className="error">{run.error}</p> : null}
      </div>

      <div className="grid split">
        <div className="card">
          <h2>Delivery timeline</h2>
          <p className="hint">Persisted progress — safe to close and reopen.</p>
          <ul className="timeline" ref={timeline}>
            {events.map((e) => (
              <li key={e.seq} className={e.level}>
                <span className="phase">{e.phase}</span>
                <span>{e.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="card">
            <h2>Execution budgets</h2>
            <p className="hint">
              Remaining of the §7 defaults. Exhaustion forces a terminal decision rather than an
              endless retry.
            </p>
            {snap.budgets ? (
              Object.entries(snap.budgets).map(([key, left]) => {
                const limit = LIMITS[key] ?? left;
                const pct = limit === 0 ? 0 : Math.max(0, Math.min(100, (left / limit) * 100));
                return (
                  <div key={key} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                      <span className="mono">
                        {left}/{limit}
                      </span>
                    </div>
                    <div className={`budget-bar${left === 0 ? ' spent' : ''}`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="empty">Not yet allocated.</p>
            )}
          </div>

          <div className="card">
            <h2>Artifacts</h2>
            <p className="hint">Versioned and immutable; accepted versions are downstream inputs.</p>
            {snap.artifacts.length === 0 ? (
              <p className="empty">None yet.</p>
            ) : (
              <table>
                <tbody>
                  {snap.artifacts.map((a) => (
                    <tr key={`${a.name}@${a.version}`}>
                      <td className="mono">
                        {a.name}@{a.version}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {a.accepted ? <span className="pill released">accepted</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Deterministic gates</h2>
        <p className="hint">
          {snap.testReport
            ? `${snap.testReport.gatesRun.length} gates run. Automated checks only — passing is not a compliance claim.`
            : 'Not run yet.'}
        </p>
        {gateFindings.length === 0 ? (
          <p className="empty">{snap.testReport ? 'No findings.' : '—'}</p>
        ) : (
          gateFindings.map((f, i) => (
            <div className="finding" key={i}>
              <span className={`sev ${f.severity}`}>{f.severity}</span>
              <div>
                <div>{f.message}</div>
                <div className="loc">
                  {f.gate} · {f.location} · proves fixed: {f.acceptanceTest}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Independent review</h2>
        <p className="hint">
          {snap.review
            ? `Terra reviewer, decision "${snap.review.decision}", score ${snap.review.qualityScore}.`
            : 'Runs once the deterministic gates pass.'}
        </p>
        {reviewFindings.length === 0 ? (
          <p className="empty">{snap.review ? 'No issues raised.' : '—'}</p>
        ) : (
          reviewFindings.map((f, i) => (
            <div className="finding" key={i}>
              <span className={`sev ${f.severity}`}>{f.severity}</span>
              <div>
                <div>{f.reason}</div>
                <div className="loc">
                  {f.category} · {f.location} · proves fixed: {f.acceptanceTest}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {run.status !== 'running' && run.status !== 'intake_insufficient' ? (
        <div className="card">
          <h2>Preview</h2>
          <p className="hint">
            Served from the project workspace.{' '}
            <Link href={`/api/preview/${run.projectId}`} target="_blank">
              Open in a new tab
            </Link>
            {run.commit ? <span className="mono"> · {run.commit.slice(0, 8)}</span> : null}
          </p>
          <iframe className="preview" src={`/api/preview/${run.projectId}`} title="Generated site preview" />
        </div>
      ) : null}
    </>
  );
}
