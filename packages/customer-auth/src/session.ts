/**
 * Server-side customer sessions.
 *
 * A session is a database row, keyed by the sha256 of a random cookie token.
 * Whether it exists, whose it is, when it expires and whether it was revoked
 * are decided from that row on every request — so logging out or revoking a
 * session takes effect immediately, and nothing a browser holds or edits can
 * name a different user.
 */
import type { StateStore } from '@statxai/state';
import { hashToken, newOpaqueToken } from './tokens.js';

export type CustomerSessionFailure = 'no_session' | 'unknown_session' | 'expired_session' | 'revoked_session';

export async function createCustomerSession(
  store: StateStore,
  customerUserId: string,
  ttlSeconds: number,
  now: Date,
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  const token = newOpaqueToken();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await store.customerSessions.insertOne({ _id: hashToken(token), customerUserId, createdAt: now, expiresAt, revokedAt: null });
  return { token, expiresAt };
}

export async function resolveCustomerSession(
  store: StateStore,
  token: string | null,
  now: Date,
): Promise<{ readonly ok: true; readonly customerUserId: string } | { readonly ok: false; readonly failure: CustomerSessionFailure }> {
  if (!token) return { ok: false, failure: 'no_session' };
  const session = await store.customerSessions.findOne({ _id: hashToken(token) });
  if (!session) return { ok: false, failure: 'unknown_session' };
  if (session.revokedAt !== null) return { ok: false, failure: 'revoked_session' };
  if (session.expiresAt.getTime() <= now.getTime()) return { ok: false, failure: 'expired_session' };
  return { ok: true, customerUserId: session.customerUserId };
}

/** Revoke one session. Idempotent; the first revocation time is kept. */
export async function revokeCustomerSession(store: StateStore, token: string, now: Date): Promise<void> {
  await store.customerSessions.updateOne({ _id: hashToken(token), revokedAt: null }, { $set: { revokedAt: now } });
}

/** Revoke every live session a customer user holds — for an operator disabling that person. */
export async function revokeAllCustomerSessions(store: StateStore, customerUserId: string, now: Date): Promise<number> {
  const result = await store.customerSessions.updateMany({ customerUserId, revokedAt: null }, { $set: { revokedAt: now } });
  return result.modifiedCount;
}
