/**
 * The editor-preview message contract, and the customer-safe words for where an
 * edit stands.
 *
 * Browser-safe. A preview frame is sandboxed without same-origin, so its
 * messages arrive from an opaque origin. The editor accepts one only when it
 * comes from exactly its own iframe's window (`event.source`), carries the random
 * channel that iframe was loaded with, and parses strictly here. The channel
 * correlates messages; it is not authorization, and every ID a message carries
 * is still resolved against the exact model before it selects anything.
 */
import * as z from 'zod/v4';

export const PREVIEW_MESSAGE_TYPE = 'statx-editor-preview';
export const PREVIEW_CHANNEL = /^[A-Za-z0-9_-]{16,64}$/;

const Marker = z.string().regex(/^(pg|sec|blk|fld|ast)_[a-f0-9]{16}$/);

export const PreviewMessage = z.discriminatedUnion('event', [
  z.strictObject({ type: z.literal(PREVIEW_MESSAGE_TYPE), version: z.literal(1), channel: z.string().regex(PREVIEW_CHANNEL), event: z.literal('ready') }),
  z.strictObject({
    type: z.literal(PREVIEW_MESSAGE_TYPE),
    version: z.literal(1),
    channel: z.string().regex(PREVIEW_CHANNEL),
    event: z.literal('select'),
    markers: z.strictObject({ page: Marker.optional(), section: Marker.optional(), block: Marker.optional(), field: Marker.optional(), asset: Marker.optional() }),
  }),
]);
export type PreviewMessage = z.infer<typeof PreviewMessage>;

/** A frame message for exactly this channel, or `null`. The caller has already checked `event.source`. */
export function parsePreviewMessage(data: unknown, channel: string): PreviewMessage | null {
  const parsed = PreviewMessage.safeParse(data);
  return parsed.success && parsed.data.channel === channel ? parsed.data : null;
}

/** What the editor tells its own frame: which object to outline. Semantic IDs only. */
export interface PreviewHighlightMessage {
  readonly type: typeof PREVIEW_MESSAGE_TYPE;
  readonly version: 1;
  readonly channel: string;
  readonly event: 'highlight';
  readonly kind: 'page' | 'section' | 'block' | 'field' | 'asset' | null;
  readonly id: string | null;
}

// ---------------------------------------------------------------------------
// Edit status, in customer words
// ---------------------------------------------------------------------------

export type CustomerEditState = 'queued' | 'running' | 'finishing' | 'completed' | 'failed';
export type CustomerEditFailure = 'validation_failed' | 'build_failed' | 'temporarily_unavailable' | 'needs_attention';

export const EDIT_STATE_LABEL: Readonly<Record<CustomerEditState, string>> = Object.freeze({
  queued: 'Saving changes…',
  running: 'Building new revision…',
  finishing: 'Validating and finishing…',
  completed: 'Changes applied',
  failed: 'Edit could not be completed',
});

export const EDIT_FAILURE_LABEL: Readonly<Record<CustomerEditFailure, string>> = Object.freeze({
  validation_failed: 'The new revision did not pass validation. Your current draft is unchanged.',
  build_failed: 'The new revision could not be built. Your current draft is unchanged.',
  temporarily_unavailable: 'The edit could not finish because a service was unavailable. Your current draft is unchanged.',
  needs_attention: 'This edit needs attention from our team before the draft can be edited again.',
});

export const isTerminalEditState = (state: CustomerEditState): boolean => state === 'completed' || state === 'failed';

/** How often the editor asks where a running edit stands. Bounded; never a busy loop. */
export const EDIT_STATUS_POLL_MS = 2_000;
