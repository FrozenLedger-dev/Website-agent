import { handleCustomerProjectCreate, handleCustomerProjects } from '@statxai/customer-editor';
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

/** Durable creation handoff only: the standalone initial-draft worker continues generation. */
export async function POST(request: Request): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerEditorDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  return handleCustomerProjectCreate(request, deps);
}
