/**
 * A local OpenID provider for tests: real discovery, a real JWKS, a real token
 * endpoint that verifies client authentication and the PKCE `code_verifier`
 * against the challenge it was given, and ID tokens signed with a real RS256
 * key — so what `openid-client` validates is exactly what it would validate
 * against a production provider. Every claim can be tampered with per code.
 *
 * Plain http on 127.0.0.1: only a test passes `allowInsecureRequests` for it.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';

export interface IssuedIdentity {
  readonly sub?: string | undefined;
  readonly email?: string;
  readonly name?: string;
  /** Overrides, applied to the ID token after the defaults — to tamper with anything. */
  readonly claims?: Record<string, unknown>;
  /** Sign with a key the provider does not publish. */
  readonly foreignKey?: boolean;
}

interface PendingCode {
  readonly challenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly identity: IssuedIdentity;
}

export class MockOidcProvider {
  readonly clientId = 'statxai-customer-test';
  readonly clientSecret = 'mock-client-secret-9f1c2e7a';
  issuer = '';
  private server!: Server;
  private key!: CryptoKey;
  private foreign!: CryptoKey;
  private kid = 'test-key-1';
  private readonly codes = new Map<string, PendingCode>();
  private counter = 0;
  readonly tokenRequests: URLSearchParams[] = [];

  async start(): Promise<void> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    this.foreign = (await generateKeyPair('RS256', { extractable: true })).privateKey;
    this.key = pair.privateKey;
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: this.kid, alg: 'RS256', use: 'sig' };

    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return send(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/jwks') return send(200, { keys: [publicJwk] });
      if (req.method === 'POST' && url.pathname === '/token') {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
        req.on('end', () => {
          void (async () => {
            const params = new URLSearchParams(raw);
            this.tokenRequests.push(params);
            // RFC 6749 §2.3.1: form-url-encoded id and secret, joined by a colon, in Basic.
            const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
            const [id, secret] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' '))) : [];
            if (id !== this.clientId || secret !== this.clientSecret) return send(401, { error: 'invalid_client' });
            const pending = this.codes.get(params.get('code') ?? '');
            if (!pending) return send(400, { error: 'invalid_grant' });
            this.codes.delete(params.get('code')!);
            const verifier = params.get('code_verifier') ?? '';
            if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            if (params.get('redirect_uri') !== pending.redirectUri) return send(400, { error: 'invalid_grant' });

            const now = Math.floor(Date.now() / 1000);
            const claims: Record<string, unknown> = {
              iss: this.issuer,
              aud: this.clientId,
              iat: now,
              exp: now + 300,
              nonce: pending.nonce,
              ...(pending.identity.sub !== undefined ? { sub: pending.identity.sub } : {}),
              ...(pending.identity.email ? { email: pending.identity.email, email_verified: true } : {}),
              ...(pending.identity.name ? { name: pending.identity.name } : {}),
              ...pending.identity.claims,
            };
            const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: this.kid }).sign(pending.identity.foreignKey ? this.foreign : this.key);
            send(200, { access_token: `provider-access-token-${this.counter}`, refresh_token: 'provider-refresh-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
          })();
        });
        return;
      }
      send(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /**
   * What a browser does at the provider: read the authorization request the app
   * redirected to, "sign the user in", and return the callback URL the provider
   * would redirect back to.
   */
  authorize(authorizationUrl: string, identity: IssuedIdentity, overrides: { state?: string } = {}): string {
    const url = new URL(authorizationUrl);
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('the app did not use PKCE S256');
    this.counter += 1;
    const code = `code-${this.counter}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge')!,
      nonce: url.searchParams.get('nonce')!,
      redirectUri: url.searchParams.get('redirect_uri')!,
      identity,
    });
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', overrides.state ?? url.searchParams.get('state')!);
    return callback.href;
  }
}
