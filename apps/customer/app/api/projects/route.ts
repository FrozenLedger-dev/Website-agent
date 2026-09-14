import { handleCustomerProjects } from '@statxai/customer-editor';
import { customerAuthUnavailableResponse, getCustomerEditorDeps } from '../../../lib/deps';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerEditorDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  return handleCustomerProjects(request, deps);
}
