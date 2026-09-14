/**
 * Customer identity: exactly one internal customer user per external identity.
 *
 * The key is the provider's `iss` and `sub` together — the only pair OpenID
 * Connect guarantees is stable and unique — enforced by a unique index. Email
 * and name are refreshed as profile metadata; they are never looked up by, so a
 * second provider account with the same email is a different person, and a
 * changed email is the same one.
 */
import type { CustomerUserDocument, StateStore } from '@statxai/state';
import { newOpaqueId } from './tokens.js';

export class CustomerIdentityInvalid extends Error {
  constructor(detail: string) {
    super(`customer identity rejected: ${detail}`);
    this.name = 'CustomerIdentityInvalid';
  }
}

export interface ExternalIdentityClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly displayName: string | null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/** Resolve — creating on first sign-in — the one customer user for an exact external identity. Creates no account and no membership. */
export async function resolveCustomerUser(store: StateStore, claims: ExternalIdentityClaims, now: Date): Promise<CustomerUserDocument> {
  if (!claims.issuer) throw new CustomerIdentityInvalid('issuer is required');
  if (!claims.subject || claims.subject.length > 255) throw new CustomerIdentityInvalid('subject is required');

  const profile = {
    email: claims.email,
    emailVerified: claims.emailVerified,
    displayName: claims.displayName,
    updatedAt: now,
    lastLoginAt: now,
  };
  const byIdentity = { issuer: claims.issuer, subject: claims.subject };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await store.customerUsers.findOneAndUpdate(
        byIdentity,
        { $set: profile, $setOnInsert: { _id: newOpaqueId('cu'), ...byIdentity, status: 'active', createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      if (user) return user;
    } catch (error) {
      // Two first sign-ins raced on the unique identity index: the winner's row is the user.
      if (!isDuplicateKeyError(error) || attempt > 0) throw error;
    }
  }
  const existing = await store.customerUsers.findOne(byIdentity);
  if (!existing) throw new CustomerIdentityInvalid('the customer user could not be resolved');
  return existing;
}
