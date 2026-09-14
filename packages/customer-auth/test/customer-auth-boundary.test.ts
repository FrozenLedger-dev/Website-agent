/**
 * Structural enforcement of the customer authority boundary.
 *
 * Customer identity is its own authority, never operator Basic auth, and never
 * anything a browser asserts. Project authorization reads tenancy only from
 * persisted state. Authentication is the mature library's, never hand-rolled.
 * And nothing beyond authentication exists yet: no editor, no project route, no
 * semantic-patch endpoint, no new build successor kind, no new tool.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', '.next', 'test'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}
const imports = (code: string) => [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

const PKG = 'packages/customer-auth/src';
const APP = 'apps/customer';

describe('customer identity is its own authority', () => {
  it('no customer code touches operator auth, and no console code touches customer auth', async () => {
    for (const file of [...(await files(PKG)), ...(await files(APP))]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/requireConsoleOperator|authenticateConsoleOperator|ConsoleOperatorPrincipal|CONSOLE_OPERATOR|console\/lib\/auth/);
      expect(code, file).not.toMatch(/headers\.get\(['"]authorization['"]\)|Basic /);
    }
    for (const file of await files('apps/console')) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/customer-auth|CustomerPrincipal|statx_customer_session/);
    }
  });

  it('the principal comes only from the session cookie and server state', async () => {
    const principal = await src(`${PKG}/principal.ts`);
    const require = body(principal, 'export async function requireCustomerPrincipal(', '\n}\n');
    expect(require.match(/request\.\w+/g) ?? []).toEqual([]);
    expect(require).toContain("readCustomerCookie(request, 'session', deps.config)");
    expect(require).toContain('deps.store.customerUsers.findOne({ _id: session.customerUserId })');
    const cookies = await src(`${PKG}/cookies.ts`);
    expect(cookies.match(/request\.headers\.get\('([^']+)'\)/g)).toEqual(["request.headers.get('cookie')"]);
  });

  it('every customer route resolves identity through the one boundary, and no route reads a customer, account or membership id from the request', async () => {
    const http = await src(`${PKG}/http.ts`);
    expect(http).not.toMatch(/searchParams\.get\('(customerUserId|accountId|tenantId|role|membership)/);
    expect(http).not.toMatch(/request\.json\(|request\.formData\(/);
    expect(body(http, 'export async function handleCustomerMe(', '\n}\n')).toContain('await requireCustomerPrincipal(request, deps)');
    for (const route of ['login', 'callback', 'logout', 'me']) {
      const code = await src(`${APP}/app/api/auth/${route}/route.ts`);
      expect(imports(code).sort(), route).toEqual(['../../../../lib/deps', '@statxai/customer-auth'].sort());
    }
  });
});

describe('authentication is the mature library’s', () => {
  it('OpenID Connect goes through openid-client: PKCE S256, state, nonce, signature checks — and no hand-rolled token handling', async () => {
    const oidc = await src(`${PKG}/oidc.ts`);
    expect(oidc).toContain("import * as client from 'openid-client';");
    expect(oidc).toContain('client.enableNonRepudiationChecks');
    const http = await src(`${PKG}/http.ts`);
    expect(http).toContain("code_challenge_method: 'S256',");
    // Our own issuer and subject checks, on top of the library's: identity is taken from nowhere else.
    expect(http).toContain('if (!claims || claims.iss !== deps.config.issuer || claims.iss !== deps.oidc.serverMetadata().issuer) return loginFailed(deps.config);');
    expect(http).toContain("if (typeof claims.sub !== 'string' || claims.sub.length === 0) return loginFailed(deps.config);");
    expect(http).toMatch(/client\.authorizationCodeGrant\(deps\.oidc, currentUrl, \{\s*pkceCodeVerifier: attempt\.codeVerifier,\s*expectedState: attempt\.state,\s*expectedNonce: attempt\.nonce,\s*idTokenExpected: true,/);
    for (const file of await files(PKG)) {
      const code = await src(file);
      expect(code, file).not.toMatch(/jwtVerify|jsonwebtoken|atob\(|split\('\.'\)|bcrypt|argon2|scrypt|pbkdf2|hashPassword|verifyPassword|passwordHash/i);
    }
  });

  it('insecure provider requests are never enabled by production code', async () => {
    for (const file of [...(await files(PKG)), ...(await files(APP))]) {
      expect(await src(file), file).not.toMatch(/allowInsecureRequests/);
    }
    const deps = await src(`${APP}/lib/deps.ts`);
    expect(deps).toContain('const oidc = await discoverCustomerOidc(config);');
  });

  it('the provider secret stays on the server: no public env var, no client component, no secret or token in any response body', async () => {
    for (const file of [...(await files(PKG)), ...(await files(APP))]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/NEXT_PUBLIC_|'use client'|"use client"/);
    }
    const http = await src(`${PKG}/http.ts`);
    expect(http).not.toMatch(/clientSecret|access_token|refresh_token|id_token|tokens\.(access|refresh)/);
    expect(http).not.toMatch(/customerSessions\.find|customerUsers\.find\(\)|Response\.json\(user\b|Response\.json\(session\b/);
  });

  it('the session table holds only the token hash, and every cookie is HttpOnly and SameSite', async () => {
    const session = await src(`${PKG}/session.ts`);
    expect(body(session, 'export async function createCustomerSession(', '\n}\n')).toContain('_id: hashToken(token)');
    const cookies = await src(`${PKG}/cookies.ts`);
    expect(cookies).toContain("'HttpOnly',");
    expect(cookies).toContain("'SameSite=Lax',");
    expect(cookies).toContain("if (config.secureCookies) parts.push('Secure');");
    const config = await src(`${PKG}/config.ts`);
    expect(config).toContain('secureCookies: production || !localHttp,');
  });
});

describe('project authorization reads tenancy from persisted state only', () => {
  it('view and edit are distinct checks over one resolver, taking only a principal and a project id', async () => {
    const tenancy = await src(`${PKG}/tenancy.ts`);
    expect(tenancy).toMatch(/export function authorizeCustomerProjectView\(store: StateStore, principal: CustomerPrincipal, projectId: string\)/);
    expect(tenancy).toMatch(/export function authorizeCustomerProjectEdit\(store: StateStore, principal: CustomerPrincipal, projectId: string\)/);
    expect(tenancy).toContain("return authorizeProject(store, principal, projectId, 'view');");
    expect(tenancy).toContain("return authorizeProject(store, principal, projectId, 'edit');");
    expect(tenancy).not.toMatch(/canAccessProject/);
    const resolver = body(tenancy, 'async function authorizeProject(', '\n}\n');
    expect(resolver).toContain('store.projectAccountBindings.findOne({ _id: projectId })');
    expect(resolver).toContain('store.customerMemberships.findOne({ accountId: binding.accountId, customerUserId: user._id })');
    expect(resolver).toContain('store.customerAccounts.findOne({ _id: binding.accountId })');
    // No account, role or membership arrives from a caller.
    expect(body(resolver, 'async function authorizeProject(', '): Promise<CustomerProjectAuthorization> {')).not.toMatch(/accountId|role|membership/);
    expect(resolver).not.toMatch(/principal\.(accountId|role|tenantId)|email/);
  });

  it('a project binding is insert-only, and indexes make identity and membership durably unique', async () => {
    const tenancy = await src(`${PKG}/tenancy.ts`);
    const bind = body(tenancy, 'export async function bindProjectToCustomerAccount(', '\n}\n');
    expect(bind).toContain('store.projectAccountBindings.insertOne(');
    expect(tenancy).not.toMatch(/projectAccountBindings\.(updateOne|updateMany|replaceOne|findOneAndUpdate|deleteOne|deleteMany)/);
    const store = await src('packages/state/src/store.ts');
    expect(store).toContain("{ key: { issuer: 1, subject: 1 }, unique: true, name: 'issuer_1_subject_1' },");
    expect(store).toContain("{ key: { accountId: 1, customerUserId: 1 }, unique: true, name: 'accountId_1_customerUserId_1' },");
    const documents = await src('packages/state/src/documents.ts');
    expect(body(documents, 'export interface ProjectDocument {', '\n}\n')).not.toMatch(/accountId|tenant|owner/);
  });

  it('identity is looked up by issuer and subject only — never by email', async () => {
    const identity = await src(`${PKG}/identity.ts`);
    expect(identity).toContain('const byIdentity = { issuer: claims.issuer, subject: claims.subject };');
    for (const file of await files(PKG)) {
      expect(await src(file), file).not.toMatch(/(findOne|find|findOneAndUpdate|updateOne|updateMany|countDocuments)\(\s*\{\s*email/);
    }
  });
});

describe('nothing beyond the authentication foundation', () => {
  it('no customer editor, project route, semantic patch endpoint or build initiation exists', async () => {
    for (const file of [...(await files(PKG)), ...(await files(APP))].filter((f) => !f.endsWith('next.config.ts'))) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/(orchestrator|workspace|agents|job-engine|contracts)|commitSemanticPatch|SemanticPatch|editable-site-model|runProject|launchRun|publishRelease|registry\./);
    }
  });

  it('no new build successor kind was added', async () => {
    const lineage = await src('packages/contracts/src/build-lineage.ts');
    expect(lineage).toMatch(/discriminatedUnion\('kind', \[ReplanSuccessorProvenance, VisualRefinementSuccessorProvenance\]\)/);
    expect(lineage).not.toMatch(/customer|semantic_edit/i);
  });

  it('the tool gateway still registers exactly filesystem and test_runner', async () => {
    const registered: string[] = [];
    for (const file of await files('packages/orchestrator/src/tool-gateway')) {
      registered.push(...[...(await src(file)).matchAll(/\btool: '([a-z_]+)'/g)].map((m) => m[1]!));
    }
    expect([...new Set(registered)].sort()).toEqual(['filesystem', 'test_runner']);
  });
});
