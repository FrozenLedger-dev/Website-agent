/**
 * The OpenID Connect client, from `openid-client` (OpenID Certified).
 *
 * Nothing about OAuth or ID tokens is implemented here by hand: discovery,
 * PKCE, state and nonce generation and checking, the code exchange, ID token
 * signature, issuer, audience, expiry and nonce validation are all the
 * library's. This module only configures it: the exact issuer, the registered
 * client, and how that client authenticates.
 */
import * as client from 'openid-client';
import type { CustomerAuthConfig } from './config.js';

export type CustomerOidcConfiguration = client.Configuration;

/**
 * Discover the provider and build the client. Production calls this with no
 * options: https only, the library's defaults. The options are the test seam
 * for a local provider, and nothing in production code passes any.
 */
export async function discoverCustomerOidc(
  config: Pick<CustomerAuthConfig, 'issuer' | 'clientId' | 'clientSecret'>,
  options?: client.DiscoveryRequestOptions,
): Promise<CustomerOidcConfiguration> {
  return client.discovery(
    new URL(config.issuer),
    config.clientId,
    undefined,
    config.clientSecret ? client.ClientSecretBasic(config.clientSecret) : client.None(),
    {
      timeout: 10,
      ...options,
      // Beyond the spec's TLS-channel trust for token-endpoint ID tokens: every ID token's
      // signature is also verified against the provider's published keys.
      execute: [...(options?.execute ?? []), client.enableNonRepudiationChecks],
    },
  );
}
