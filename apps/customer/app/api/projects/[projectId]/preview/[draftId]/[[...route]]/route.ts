import { handleCustomerEditorPreview } from '@statxai/customer-editor';
import { customerAuthUnavailableResponse, getCustomerEditorDeps } from '../../../../../../../lib/deps';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string; route?: string[] }> }): Promise<Response> {
  let deps;
  try {
    deps = await getCustomerEditorDeps();
  } catch {
    return customerAuthUnavailableResponse();
  }
  const { projectId, draftId, route } = await params;
  return handleCustomerEditorPreview(request, deps, { projectId, draftId, route: route ?? [] });
}
