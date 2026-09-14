'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerGenerationFailure, CustomerGenerationState, CustomerGenerationStatusView } from '@statxai/customer-editor';

const POLL_MS = 2_500;

const STAGE_LABEL: Record<CustomerGenerationState, string> = {
  queued: 'Queued',
  planning: 'Planning the site',
  building: 'Building the site',
  validating: 'Checking the result',
  finishing: 'Finishing up',
  completed: 'Done',
  failed: 'Could not finish',
};

const STAGE_ORDER: readonly CustomerGenerationState[] = ['queued', 'planning', 'building', 'validating', 'finishing'];

const FAILURE_TEXT: Record<CustomerGenerationFailure, string> = {
  invalid_request: 'The business details submitted were not enough to generate a website. Please start over with more detail.',
  generation_failed: 'We could not generate a website from this brief. Please try again with different details.',
  temporarily_unavailable: 'Generation is temporarily unavailable. Please try again shortly.',
  needs_attention: 'Generation needs attention. Please try again later, or contact support if this continues.',
};

export function GeneratingStatus({ projectId, initialStatus }: { readonly projectId: string; readonly initialStatus: CustomerGenerationStatusView }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (stopped.current) return;
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/generation`, { cache: 'no-store', credentials: 'same-origin' });
        if (response.status === 401) {
          window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        if (response.ok) {
          const next = (await response.json()) as CustomerGenerationStatusView;
          if (stopped.current) return;
          setStatus(next);
          if (next.state === 'completed') {
            stopped.current = true;
            router.replace(`/projects/${encodeURIComponent(projectId)}/editor`);
            return;
          }
          if (next.state === 'failed') {
            stopped.current = true;
            return;
          }
        }
      } catch {
        // A transient network failure just tries again on the next tick.
      }
      if (!stopped.current) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, router]);

  if (status.state === 'failed') {
    return (
      <p role="alert" className="notice notice-error">
        {FAILURE_TEXT[status.failure ?? 'needs_attention']}
      </p>
    );
  }

  return (
    <div role="status" aria-live="polite">
      <p className="stage-current">{STAGE_LABEL[status.state]}</p>
      <ol className="stage-list">
        {STAGE_ORDER.map((stage) => {
          const reached = STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(status.state);
          return (
            <li key={stage} aria-current={stage === status.state ? 'step' : undefined}>
              {reached ? '✓ ' : '· '}
              {STAGE_LABEL[stage]}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
