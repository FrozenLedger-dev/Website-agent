/**
 * Who is asking, for a server component: the same one customer authentication
 * boundary every route uses, fed exactly the session cookie of this request.
 */
import { headers } from 'next/headers';
import { requireCustomerPrincipal, type CustomerPrincipal } from '@statxai/customer-auth';
import type { CustomerEditorDeps } from '@statxai/customer-editor';

export async function currentCustomerPrincipal(deps: CustomerEditorDeps): Promise<CustomerPrincipal | null> {
  const cookie = (await headers()).get('cookie');
  const request = new Request(deps.config.appOrigin, { headers: cookie ? { cookie } : {} });
  const auth = await requireCustomerPrincipal(request, deps);
  return auth.ok ? auth.principal : null;
}

/** Where an unauthenticated visitor to `path` is sent: the customer login, returning to exactly that path. */
export function loginPathFor(path: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(path)}`;
}
