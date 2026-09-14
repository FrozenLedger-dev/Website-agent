import { handleCustomerCallback } from '@statxai/customer-auth';
import { customerAuthUnavailableResponse, getCustomerAuthDeps } from '../../../../lib/deps';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerAuthDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  return handleCustomerCallback(request, deps);
}
