'use client';

/** Any unexpected failure: a generic message and a retry — never the exception text. */
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="page narrow">
      <h1>Something went wrong</h1>
      <p>This page could not be loaded right now. Your drafts are unchanged.</p>
      <button type="button" className="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
