/**
 * `test_runner` against the real sandbox: nothing faked below the gateway.
 *
 * A proposed candidate is materialised onto the real scaffold, compiled by a
 * real `next build` in the b69e841 sandbox, and measured by the real gates. The
 * hostile candidate here throws its own reconnaissance out of prerender — so
 * the only channel it has back is the bounded, sanitized diagnostics the model
 * would read — and what it reports is checked: no secrets, no host files, no
 * network, the trusted manifest.
 *
 * Integration: needs a Docker daemon, and network access for Google Fonts.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildOutput, SitePlan, TestRunnerResult } from '@statxai/contracts';
import { ProjectWorkspace, SANDBOX_LABEL, defaultTemplateRoot, scaffoldSite } from '@statxai/workspace';
import { ToolGateway, type ToolEvidence } from '../src/tool-gateway/gateway.js';
import { TEST_RUNNER_MAX_DIAGNOSTIC_CHARS, TEST_RUNNER_MAX_RESULT_BYTES, createTestRunnerAdapter } from '../src/tool-gateway/test-runner.js';

const exec = promisify(execFile);

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-test-runner-probe-openai-19af',
  VERCEL_TOKEN: 'vercel-test-runner-probe-token-3c7e',
  MONGODB_URI: 'mongodb://harness:test-runner-probe-mongo-pw@mongo.internal:27017/statxai',
};
const saved: Record<string, string | undefined> = {};

let root: string;
let advisoryRoot: string;
let sentinel: string;
let evidence: ToolEvidence[];
let run: (candidate: unknown, signal?: AbortSignal) => Promise<TestRunnerResult>;

const PROFILE = { businessName: 'Harrowgate Joinery', services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }], contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' } };
const PLAN = {
  brandSystem: { typography: { headingFamily: 'Inter Tight', bodyFamily: 'Inter Tight' }, palette: {}, radius: 'square', artDirection: 'd' },
  sitemap: { pages: [{ route: '/', title: 'Home', metaDescription: 'd', sections: [] }] },
  acceptanceCriteria: [],
} as unknown as SitePlan;

const exists = (path: string) => access(path).then(() => true, () => false);
const sandboxContainers = async () =>
  (await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=run`])).stdout.split('\n').filter(Boolean);

beforeAll(async () => {
  for (const [key, value] of Object.entries(FAKE_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  root = await mkdtemp(join(tmpdir(), 'statxai-test-runner-real-'));
  advisoryRoot = join(root, 'advisory');
  sentinel = join(root, 'host-sentinel.txt');
  await writeFile(sentinel, 'host-only sentinel contents');
  evidence = [];
  const gateway = new ToolGateway({
    adapters: [createTestRunnerAdapter({ profile: PROFILE as never, plan: PLAN, workspacesRoot: advisoryRoot })],
    onEvidence: (e) => evidence.push(e),
  });
  run = (candidate, signal) =>
    gateway.execute<TestRunnerResult>({
      tool: 'test_runner',
      input: { candidate },
      context: { projectId: 'proj_real_runner', jobId: 'job_real_runner', skill: 'terra-build', role: 'frontend_backend', allowedTools: ['filesystem', 'test_runner'], supportedTools: ['filesystem', 'test_runner'] },
      ...(signal ? { signal } : {}),
    });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

const page = (contents: string): BuildOutput => ({ files: [{ path: 'app/page.tsx', contents }], notes: 'probe' });

describe('real advisory measurement', () => {
  it('a TypeScript compile failure is passed:false with the compiler’s own diagnosis, bounded and sanitized', async () => {
    const result = await run(page(`export default function Page() {\n  const count: number = 'not a number';\n  return <main>{count}</main>;\n}\n`));

    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.compile?.ok).toBe(false);
    expect(result.compile?.diagnostics).toMatch(/app\/page\.tsx\(2,\d+\): error TS2322/);
    expect(result.compile!.diagnostics.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_DIAGNOSTIC_CHARS);
    const serialised = JSON.stringify(result);
    for (const leaked of [...Object.values(FAKE_SECRETS), root, homedir(), process.cwd()]) expect(serialised).not.toContain(leaked);
    expect(await readdir(advisoryRoot)).toEqual([]);
    expect(await sandboxContainers()).toEqual([]);
  }, 600_000);

  it('a hostile candidate sees no secrets, host files or network, and builds with the trusted manifest', async () => {
    const hostile = `import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

function attempt(fn: () => unknown): string {
  try { return String(fn()); } catch (error) { const e = error as NodeJS.ErrnoException; return 'error:' + (e.code ?? 'x'); }
}
function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 }, () => { s.destroy(); resolve('connected'); });
    s.on('error', (e: NodeJS.ErrnoException) => resolve('error:' + e.code));
    s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  });
}

export default async function Page() {
  const env = execSync('env').toString();
  const report = {
    secretKeys: Object.keys(process.env).filter((k) => /OPENAI|VERCEL|MONGO|ANTHROPIC/.test(k)),
    childSecret: /OPENAI|VERCEL|MONGO/.test(env),
    sentinel: attempt(() => readFileSync(${JSON.stringify(sentinel)}, 'utf8')),
    dockerSocket: existsSync('/var/run/docker.sock'),
    uid: process.getuid?.(),
    manifest: createHash('sha256').update(readFileSync(process.cwd() + '/package.json')).digest('hex').slice(0, 16),
    direct: await tcp('1.1.1.1', 443),
    metadata: await tcp('169.254.169.254', 80),
  };
  throw new Error('PROBE' + JSON.stringify(report) + 'PROBE');
}
`;
    const result = await run(page(hostile));

    expect(result.status).toBe('failed');
    const match = /PROBE(\{.*?\})PROBE/.exec(result.compile!.diagnostics);
    expect(match, result.compile!.diagnostics).not.toBeNull();
    const report = JSON.parse(match![1]!) as Record<string, unknown>;

    expect(report.secretKeys).toEqual([]);
    expect(report.childSecret).toBe(false);
    expect(report.sentinel).toBe('error:ENOENT');
    expect(report.dockerSocket).toBe(false);
    expect(report.uid).not.toBe(0);
    expect(report.direct).not.toBe('connected');
    expect(report.metadata).not.toBe('connected');
    const trusted = createHash('sha256').update(await readFile(join(defaultTemplateRoot(), 'package.json'))).digest('hex').slice(0, 16);
    expect(report.manifest).toBe(trusted);
    expect(JSON.stringify(result)).not.toContain('host-only sentinel contents');
  }, 600_000);

  it('a candidate that compiles is measured by the real gates, with structured, bounded findings', async () => {
    const result = await run(page(`import type { Metadata } from 'next';\nexport const metadata: Metadata = { title: 'Harrowgate Joinery', description: 'Fitted wardrobes in Harrogate.' };\nexport default function Page() {\n  return <main><h1>Harrowgate Joinery</h1><p>Fitted wardrobes.</p></main>;\n}\n`));

    expect(result.compile).toEqual({ ok: true, diagnostics: '' });
    expect(['passed', 'failed']).toContain(result.status);
    expect(result.passed).toBe(result.status === 'passed');
    if (result.passed) expect(result.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')).toEqual([]);
    else expect(result.findings.some((f) => f.severity === 'P0' || f.severity === 'P1')).toBe(true);
    for (const finding of result.findings) {
      expect(Object.keys(finding).sort()).toEqual(['gate', 'location', 'message', 'severity']);
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TEST_RUNNER_MAX_RESULT_BYTES);
    expect(await readdir(advisoryRoot)).toEqual([]);
  }, 600_000);

  it('changes no canonical workspace or Git HEAD, and records only safe evidence', async () => {
    const canonical = await ProjectWorkspace.open('proj_real_runner', join(root, 'canonical'));
    await scaffoldSite(canonical.siteRoot);
    await canonical.writeSiteFiles([{ path: 'app/page.tsx', contents: 'export default function Canonical(){return null}' }]);
    const head = await canonical.commit('canonical');
    const snapshot = await readFile(join(canonical.siteRoot, 'app', 'page.tsx'), 'utf8');
    evidence.length = 0;

    await run(page(`export default function Page() {\n  const n: number = 'x';\n  return <main>{n}</main>;\n}\n`));

    expect(await canonical.currentCommit()).toBe(head);
    expect(await readFile(join(canonical.siteRoot, 'app', 'page.tsx'), 'utf8')).toBe(snapshot);
    expect(await exists(join(canonical.siteRoot, 'out'))).toBe(false);
    expect(evidence).toHaveLength(1);
    expect(Object.keys(evidence[0]!.detail).sort()).toEqual(['candidateHash', 'files', 'findings', 'passed', 'status']);
    expect(JSON.stringify(evidence)).not.toContain("'x'");
  }, 600_000);

  it('cancellation terminates the sandboxed build and leaves nothing behind', async () => {
    const controller = new AbortController();
    const reason = new Error('lease lost');
    const measuring = run(page(`export default function Page() {\n  return <main>cancelled</main>;\n}\n`), controller.signal);

    const deadline = Date.now() + 120_000;
    while (!(await exec('ps', ['-eo', 'args'])).stdout.includes('node_modules/next/dist/bin/next build')) {
      if (Date.now() > deadline) throw new Error('the sandboxed build never started');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort(reason);

    await expect(measuring).rejects.toBe(reason);
    expect((await exec('ps', ['-eo', 'args'])).stdout).not.toContain('node_modules/next/dist/bin/next build');
    expect(await sandboxContainers()).toEqual([]);
    expect(await readdir(advisoryRoot)).toEqual([]);
    expect(evidence.at(-1)).toMatchObject({ tool: 'test_runner', outcome: 'cancelled' });
  }, 600_000);
});
