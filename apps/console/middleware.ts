import { NextResponse } from 'next/server';
import { requireConsoleOperator } from '@/lib/auth';

/**
 * The console's outer authenticated boundary (Phase 5o).
 *
 * Everything the console serves is operator-only: the dashboard and run pages
 * read run state directly in their server components, so protecting only
 * `app/api/**` would leave exactly the same data readable one URL over. There
 * are no public endpoints — no health, readiness or liveness route exists in
 * this console, and Phase 5o does not invent one to have an exception. Adding
 * one later means adding it to this matcher *and* to the allowlist in
 * `test/console-auth.test.ts`, deliberately, in both places.
 *
 * The `_next/static` and `_next/image` exclusions are the framework's own
 * build output and optimiser — client-component JavaScript and images, no run
 * state, no project data, no configuration. Excluding them keeps the 401
 * challenge on the document, which is what makes the browser prompt.
 *
 * This is the outer boundary, not the only one: every API route handler calls
 * `requireConsoleOperator` itself as well, so a mistake in the matcher below
 * cannot expose one. Both call the same authority.
 */
export async function middleware(request: Request) {
  const auth = await requireConsoleOperator(request);
  if (auth instanceof Response) return auth;
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
