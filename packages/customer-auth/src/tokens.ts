/** Opaque random tokens and ids, and the one-way hash the database keeps instead of a token. */
import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, base64url — 43 characters. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A server-minted opaque id: a type prefix and 128 random bits. */
export function newOpaqueId(prefix: 'cu' | 'acct' | 'mem'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}
