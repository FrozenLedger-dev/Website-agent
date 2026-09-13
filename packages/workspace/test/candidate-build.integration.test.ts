/**
 * Real `next build`s of model-authored code, through `buildSite` — the path
 * the official validator and canonical evaluation both take.
 *
 * The candidate here is hostile. Its home page is a server component, so it
 * executes during prerender, and it spends that execution looking for the
 * harness's secrets, a host sentinel file, somewhere outside its workspace to
 * write, the network and the Docker socket — then writes what it found into
 * the export. The canonical site it is built from has also been tampered with
 * on disk: a model-authored `package.json` with a malicious build script, a
 * malicious `next.config.ts`, and a fake `next` binary in `node_modules`.
 *
 * Integration: needs a Docker daemon, and network access for Google Fonts.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectWorkspace,
  SANDBOX_LABEL,
  buildSite,
  defaultTemplateRoot,
  scaffoldSite,
  type BuildResult,
} from '../src/index.js';

const exec = promisify(execFile);

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-candidate-build-openai-2c81f',
  VERCEL_TOKEN: 'vercel-candidate-build-token-a07e',
  MONGODB_URI: 'mongodb://harness:candidate-build-mongo-pw@mongo.internal:27017/statxai',
};
const saved: Record<string, string | undefined> = {};

let root: string;
let sandboxRoot: string;
let hostSentinel: string;
let escapeTarget: string;
let tamperSentinel: string;

const exists = (path: string) => access(path).then(() => true, () => false);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Executes at prerender, inside the build: everything hostile code would try, reported into the page. */
function hostilePage(): string {
  return `import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

function attempt(fn: () => unknown): string {
  try {
    return String(fn());
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return 'error:' + (e.code ?? e.message);
  }
}

function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3000 }, () => {
      socket.destroy();
      resolve('connected');
    });
    socket.on('error', (e: NodeJS.ErrnoException) => resolve('error:' + e.code));
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
  });
}

export default async function Page() {
  const report = {
    env: process.env,
    grandchildEnv: attempt(() => execSync('env').toString()),
    uid: process.getuid?.(),
    sentinel: attempt(() => readFileSync(${JSON.stringify(hostSentinel)}, 'utf8')),
    escape: attempt(() => {
      writeFileSync(${JSON.stringify(escapeTarget)}, 'escaped');
      return 'written';
    }),
    dockerSocket: existsSync('/var/run/docker.sock') || existsSync('/run/docker.sock'),
    manifest: createHash('sha256').update(readFileSync(process.cwd() + '/package.json')).digest('hex'),
    nextConfig: createHash('sha256').update(readFileSync(process.cwd() + '/next.config.ts')).digest('hex'),
    directNetwork: await tcp('1.1.1.1', 443),
    metadata: await tcp('169.254.169.254', 80),
  };
  return (
    <main>
      <h1>Sandbox probe</h1>
      <pre id="report">{JSON.stringify(report)}</pre>
    </main>
  );
}
`;
}

/** The report the hostile page wrote into its export. */
function readReport(html: string): Record<string, unknown> {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(html);
  if (!match) throw new Error('no report in the export');
  const text = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every file under `dir` except the export, by content hash. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const path = relative(dir, full);
      if (path === join('app', 'out') || path === '.git') continue;
      if (entry.isDirectory()) await walk(full);
      else files[path] = sha256(await readFile(full));
    }
  };
  await walk(dir);
  return files;
}

async function sandboxContainers(): Promise<string[]> {
  const { stdout } = await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=run`]);
  return stdout.split('\n').filter(Boolean);
}

async function runsLeft(): Promise<string[]> {
  return readdir(join(sandboxRoot, 'runs')).catch(() => []);
}

async function scaffoldedSite(name: string, page: string): Promise<string> {
  const site = join(root, name, 'app');
  await mkdir(site, { recursive: true });
  await scaffoldSite(site);
  await writeFile(join(site, 'app', 'page.tsx'), page);
  return site;
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(FAKE_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  root = await mkdtemp(join(tmpdir(), 'statxai-candidate-build-'));
  sandboxRoot = join(root, 'sandbox');
  hostSentinel = join(root, 'host-sentinel.txt');
  escapeTarget = join(root, 'escaped-from-build.txt');
  tamperSentinel = join(root, 'tampered-manifest-ran.txt');
  await writeFile(hostSentinel, 'host-only sentinel contents');
}, 60_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe('a hostile candidate, built from a tampered canonical workspace', () => {
  let ws: ProjectWorkspace;
  let result: BuildResult;
  let report: Record<string, unknown>;
  let before: Record<string, string>;
  let headBefore: string;
  let statusBefore: string;
  let tamperedManifest: string;

  const git = async (...args: string[]) => (await exec('git', ['-C', ws.root, ...args])).stdout.trim();

  beforeAll(async () => {
    ws = await ProjectWorkspace.open('canonical', join(root, 'workspaces'));
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles([{ path: 'app/page.tsx', contents: hostilePage() }]);
    await ws.commit('canonical baseline');

    // Model-shaped tampering that bypassed the write boundary on disk. None of
    // it may reach the build.
    const evil = `require('node:fs').writeFileSync(${JSON.stringify(tamperSentinel)}, 'ran')`;
    const manifest = JSON.parse(await readFile(join(ws.siteRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    manifest.scripts = { prebuild: `node -e "${evil.replace(/"/g, '\\"')}"`, build: `node -e "${evil.replace(/"/g, '\\"')}"` };
    tamperedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(ws.siteRoot, 'package.json'), tamperedManifest);
    await writeFile(join(ws.siteRoot, 'next.config.ts'), `${evil};\nexport default { output: 'export' };\n`);
    await mkdir(join(ws.siteRoot, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
    await writeFile(join(ws.siteRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), `${evil};\n`);

    before = await snapshot(ws.root);
    headBefore = await git('rev-parse', 'HEAD');
    statusBefore = await git('status', '--porcelain');

    result = await buildSite(ws.siteRoot, { sandboxRoot });
    report = result.ok ? readReport(await readFile(join(ws.siteRoot, 'out', 'index.html'), 'utf8')) : {};
  }, 900_000);

  it('builds the valid candidate successfully, producing its export', async () => {
    expect(result.output).not.toContain('Build terminated');
    expect(result.ok).toBe(true);
    expect(result.outDir).toBe(join(ws.siteRoot, 'out'));
    expect(await readFile(join(ws.siteRoot, 'out', 'index.html'), 'utf8')).toContain('Sandbox probe');
    // Google Fonts were reached through the allowlist proxy and self-hosted into the export.
    const media = await readdir(join(ws.siteRoot, 'out', '_next', 'static', 'media'));
    expect(media.some((file) => file.endsWith('.woff2'))).toBe(true);
  });

  it('the candidate cannot observe a fake OPENAI_API_KEY injected into the harness', () => {
    expect(report.env).toHaveProperty('NODE_ENV', 'production');
    expect(report.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.OPENAI_API_KEY);
  });

  it('the candidate cannot observe a fake VERCEL_TOKEN', () => {
    expect(report.env).not.toHaveProperty('VERCEL_TOKEN');
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.VERCEL_TOKEN);
  });

  it('the candidate cannot observe fake Mongo credentials, in its own process or a child', () => {
    expect(report.env).not.toHaveProperty('MONGODB_URI');
    expect(String(report.grandchildEnv)).toContain('NODE_ENV=production');
    expect(JSON.stringify(report)).not.toContain('candidate-build-mongo-pw');
  });

  it('the candidate cannot read a sentinel file outside its workspace', () => {
    expect(report.sentinel).toBe('error:ENOENT');
    expect(JSON.stringify(report)).not.toContain('host-only sentinel contents');
  });

  it('the candidate cannot write outside its workspace', async () => {
    expect(report.escape).toMatch(/^error:(ENOENT|EROFS|EACCES)$/);
    expect(await exists(escapeTarget)).toBe(false);
  });

  it('the candidate’s network requests are blocked', () => {
    expect(report.directNetwork).not.toBe('connected');
    expect(report.metadata).not.toBe('connected');
  });

  it('the candidate cannot reach the Docker socket', () => {
    expect(report.dockerSocket).toBe(false);
  });

  it('runs under a restricted, non-root user', () => {
    expect(typeof report.uid).toBe('number');
    expect(report.uid).not.toBe(0);
  });

  it('builds with the trusted scaffold package.json and config, not the tampered ones', async () => {
    expect(report.manifest).toBe(sha256(await readFile(join(defaultTemplateRoot(), 'package.json'))));
    expect(report.manifest).not.toBe(sha256(tamperedManifest));
    expect(report.nextConfig).toBe(sha256(await readFile(join(defaultTemplateRoot(), 'next.config.ts'))));
  });

  it('never executes a candidate manifest script, config or binary', async () => {
    expect(await exists(tamperSentinel)).toBe(false);
  });

  it('leaves the canonical workspace unchanged, apart from the export it was asked for', async () => {
    expect(await snapshot(ws.root)).toEqual(before);
    for (const generated of ['.next', 'next-env.d.ts', 'tsconfig.tsbuildinfo']) {
      expect(await exists(join(ws.siteRoot, generated))).toBe(false);
    }
  });

  it('leaves the canonical Git HEAD and working-tree status unchanged', async () => {
    expect(await git('rev-parse', 'HEAD')).toBe(headBefore);
    const status = (await git('status', '--porcelain'))
      .split('\n')
      .filter((line) => !line.includes('app/out/'))
      .join('\n');
    expect(status).toBe(statusBefore);
  });

  it('removes its build workspace and container after success', async () => {
    expect(await runsLeft()).toEqual([]);
    expect(await sandboxContainers()).toEqual([]);
  });

  it('returns output free of harness secrets and host paths', () => {
    for (const value of Object.values(FAKE_SECRETS)) expect(result.output).not.toContain(value);
    for (const path of [root, homedir(), process.cwd()]) expect(result.output).not.toContain(path);
  });
});

describe('a candidate that does not compile', () => {
  let site: string;
  let result: BuildResult;

  beforeAll(async () => {
    site = await scaffoldedSite(
      'broken',
      `export default function Page() {\n  const count: number = 'not a number';\n  return <main>{count}</main>;\n}\n`,
    );
    result = await buildSite(site, { sandboxRoot });
  }, 600_000);

  it('is a build failure with the compiler’s own diagnosis, bounded', () => {
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/app\/page\.tsx\(2,\d+\): error TS2322/);
    expect(result.output).toContain('app/page.tsx');
    expect(result.output.length).toBeLessThanOrEqual(4_002);
  });

  it('carries no harness secret or host path in its diagnostics', () => {
    for (const value of Object.values(FAKE_SECRETS)) expect(result.output).not.toContain(value);
    for (const path of [root, sandboxRoot, site, homedir(), process.cwd()]) expect(result.output).not.toContain(path);
  });

  it('produces no export and removes its build workspace and container', async () => {
    expect(await exists(join(site, 'out'))).toBe(false);
    expect(await runsLeft()).toEqual([]);
    expect(await sandboxContainers()).toEqual([]);
  });
});

describe('cancellation of a real build', () => {
  const waitForBuildProcess = async () => {
    const deadline = Date.now() + 120_000;
    while (!(await exec('ps', ['-eo', 'args'])).stdout.includes('node_modules/next/dist/bin/next build')) {
      if (Date.now() > deadline) throw new Error('the sandboxed build never started');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('a wall-clock timeout terminates the build, reports a failure, and cleans up', async () => {
    const site = await scaffoldedSite('slow', `export default function Page() {\n  return <main>slow</main>;\n}\n`);

    const result = await buildSite(site, { sandboxRoot, limits: { timeoutMs: 3_000 } });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Build terminated: it exceeded the 3s time limit.');
    expect(await exists(join(site, 'out'))).toBe(false);
    expect(await runsLeft()).toEqual([]);
    expect(await sandboxContainers()).toEqual([]);
    expect((await exec('ps', ['-eo', 'args'])).stdout).not.toContain('node_modules/next/dist/bin/next build');
  }, 300_000);

  it('AbortSignal terminates the build and every process in it, and cleans up', async () => {
    const site = await scaffoldedSite('aborted', `export default function Page() {\n  return <main>aborted</main>;\n}\n`);
    const controller = new AbortController();
    const reason = new Error('run cancelled');

    const building = buildSite(site, { sandboxRoot, signal: controller.signal });
    await waitForBuildProcess();
    controller.abort(reason);

    await expect(building).rejects.toBe(reason);
    expect((await exec('ps', ['-eo', 'args'])).stdout).not.toContain('node_modules/next/dist/bin/next build');
    expect(await exists(join(site, 'out'))).toBe(false);
    expect(await runsLeft()).toEqual([]);
    expect(await sandboxContainers()).toEqual([]);
  }, 300_000);
});
