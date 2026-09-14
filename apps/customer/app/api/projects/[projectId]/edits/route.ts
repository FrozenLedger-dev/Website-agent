import { handleCustomerEditSubmit } from '@statxai/customer-editor';
import { customerAuthUnavailableResponse, getCustomerEditorDeps } from '../../../../../lib/deps';

export const dynamic = 'force-dynamic';

/** Durable submission only: the standalone semantic-edit worker continues the edit. */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerEditorDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  const { projectId } = await params;
  return handleCustomerEditSubmit(request, deps, projectId);
}
