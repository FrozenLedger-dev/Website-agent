import { handleCustomerGenerationStatus } from '@statxai/customer-editor';
import { customerAuthUnavailableResponse, getCustomerEditorDeps } from '../../../../../lib/deps';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerEditorDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  const { projectId } = await params;
  return handleCustomerGenerationStatus(request, deps, projectId);
}
