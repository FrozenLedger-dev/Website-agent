/**
 * The sandbox's isolation, enforced — probed from inside a real container.
 *
 * Every probe is untrusted code doing what hostile generated code would try:
 * read the harness's secrets, read and write host files, reach the network,
 * the cloud metadata endpoint or the Docker socket, fork without bound,
 * allocate without bound, and outlive its cancellation. Each is run through
 * `runSandboxed` exactly as a build is, and the host is checked afterwards.
 *
 * Integration: needs a Docker daemon, and network access for the Google Fonts
 * allowlist probe.
 */
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_LIMITS,
  EGRESS_PROXY_NAME,
  SANDBOX_LABEL,
  runSandboxed,
  sandboxUser,
  type SandboxLimits,
  type SandboxNetwork,
} from '../src/index.js';

const exec = promisify(execFile);

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-sandbox-probe-openai-7f3a9c',
  VERCEL_TOKEN: 'vercel-sandbox-probe-token-51e2d0',
  MONGODB_URI: 'mongodb://harness:sandbox-probe-mongo-pw@mongo.internal:27017/statxai',
  ANTHROPIC_API_KEY: 'sk-ant-sandbox-probe-99b1',
};
const saved: Record<string, string | undefined> = {};

let root: string;
let outside: string;
let sentinel: string;

beforeAll(async () => {
  for (const [key, value] of Object.entries(FAKE_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  root = await mkdtemp(join(tmpdir(), 'statxai-sandbox-probe-'));
  outside = join(root, 'outside');
  await mkdir(outside);
  sentinel = join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'host-only sentinel contents');
}, 600_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

/** Run a CommonJS probe in a fresh disposable workspace; returns its last JSON line and the run. */
async function probe(body: string, options: { network?: SandboxNetwork; limits?: Partial<SandboxLimits>; signal?: AbortSignal } = {}) {
  const workspace = await mkdtemp(join(root, 'ws-'));
  await writeFile(join(workspace, 'probe.cjs'), `(async () => {\n${body}\n})();`);
  const run = await runSandboxed({
    workspace,
    command: ['node', 'probe.cjs'],
    network: options.network ?? 'font-egress',
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const line = run.output.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  return { run, workspace, report: line ? (JSON.parse(line) as Record<string, unknown>) : {} };
}

async function sandboxContainers(): Promise<string[]> {
  const { stdout } = await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=run`]);
  return stdout.split('\n').filter(Boolean);
}

async function sandboxNetworks(): Promise<string[]> {
  const { stdout } = await exec('docker', ['network', 'ls', '--quiet', '--filter', `label=${SANDBOX_LABEL}=network`]);
  return stdout.split('\n').filter(Boolean);
}

async function hostProcesses(): Promise<string> {
  return (await exec('ps', ['-eo', 'args'])).stdout;
}

const exists = (path: string) => access(path).then(() => true, () => false);

const HELPERS = `
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns').promises;
const cp = require('node:child_process');
const attempt = (fn) => { try { return String(fn()); } catch (e) { return 'error:' + (e.code || e.message); } };
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 3000 }, () => { s.destroy(); resolve('connected'); });
  s.on('error', (e) => resolve('error:' + e.code));
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
});
const viaProxy = (target) => new Promise((resolve) => {
  const s = net.connect({ host: '${EGRESS_PROXY_NAME}', port: 3128, timeout: 5000 }, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n'));
  s.once('data', (d) => { resolve(String(d).split('\\r\\n')[0]); s.destroy(); });
  s.on('error', (e) => resolve('error:' + e.code));
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
});
`;

describe('environment isolation', () => {
  let report: Record<string, unknown>;

  beforeAll(async () => {
    ({ report } = await probe(`${HELPERS}
      console.log(JSON.stringify({ env: process.env, grandchild: attempt(() => cp.execSync('env').toString()) }));
    `));
  }, 120_000);

  it('the untrusted process sees no fake OPENAI_API_KEY injected into the harness', () => {
    expect(JSON.stringify(report)).toContain('NODE_ENV');
    expect(report.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.OPENAI_API_KEY);
  });

  it('the untrusted process sees no fake VERCEL_TOKEN', () => {
    expect(report.env).not.toHaveProperty('VERCEL_TOKEN');
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.VERCEL_TOKEN);
  });

  it('the untrusted process sees no fake Mongo credentials', () => {
    expect(report.env).not.toHaveProperty('MONGODB_URI');
    expect(JSON.stringify(report)).not.toContain('sandbox-probe-mongo-pw');
  });

  it('holds exactly the built environment plus the image’s own defaults — in the process and its children', () => {
    expect(Object.keys(report.env as object).sort()).toEqual(
      ['CI', 'HOME', 'HOSTNAME', 'HTTPS_PROXY', 'NEXT_TELEMETRY_DISABLED', 'NODE_ENV', 'NODE_VERSION', 'PATH', 'PWD', 'YARN_VERSION'].sort(),
    );
    const grandchild = String(report.grandchild);
    expect(grandchild).toContain('NODE_ENV=production');
    for (const value of Object.values(FAKE_SECRETS)) expect(grandchild).not.toContain(value);
    expect(grandchild).not.toMatch(/OPENAI|VERCEL|MONGO|ANTHROPIC/);
  });
});

describe('filesystem isolation', () => {
  it('cannot read a sentinel file outside its workspace', async () => {
    const { report } = await probe(`${HELPERS}
      console.log(JSON.stringify({
        sentinel: attempt(() => fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8')),
        outsideDir: attempt(() => fs.readdirSync(${JSON.stringify(outside)}).join(',')),
        repo: attempt(() => fs.readdirSync(${JSON.stringify(process.cwd())}).join(',')),
        parent: attempt(() => fs.readdirSync('/site/..').join(',')),
      }));
    `);

    expect(report.sentinel).toBe('error:ENOENT');
    expect(report.outsideDir).toBe('error:ENOENT');
    expect(report.repo).toBe('error:ENOENT');
    expect(String(report.parent)).not.toContain('sentinel');
    expect(JSON.stringify(report)).not.toContain('host-only sentinel contents');
  }, 120_000);

  it('cannot write a sentinel outside its workspace, while writing inside it works', async () => {
    const escapes = [join(outside, 'written-by-sandbox.txt'), join(root, 'written-by-sandbox.txt')];
    const { report, workspace } = await probe(`${HELPERS}
      const targets = ${JSON.stringify(escapes)};
      console.log(JSON.stringify({
        escapes: targets.map((t) => attempt(() => { fs.mkdirSync(require('node:path').dirname(t), { recursive: true }); fs.writeFileSync(t, 'x'); return 'written'; })),
        rootfs: attempt(() => { fs.writeFileSync('/etc/written-by-sandbox', 'x'); return 'written'; }),
        aboveWorkspace: attempt(() => { fs.writeFileSync('/site/../written-by-sandbox', 'x'); return 'written'; }),
        inside: attempt(() => { fs.writeFileSync('/site/inside.txt', 'inside'); return 'written'; }),
      }));
    `);

    for (const target of escapes) expect(await exists(target)).toBe(false);
    expect(report.rootfs).toBe('error:EROFS');
    expect(report.aboveWorkspace).toBe('error:EROFS');
    expect(report.inside).toBe('written');
    expect(await readFile(join(workspace, 'inside.txt'), 'utf8')).toBe('inside');
  }, 120_000);

  it('cannot modify the trusted dependency tree mounted into it', async () => {
    const workspace = await mkdtemp(join(root, 'ws-'));
    const deps = await mkdtemp(join(root, 'deps-'));
    await mkdir(join(workspace, 'node_modules'));
    await writeFile(join(deps, 'trusted.js'), 'trusted');
    await writeFile(join(workspace, 'probe.cjs'), `${HELPERS}
      console.log(JSON.stringify({
        read: attempt(() => fs.readFileSync('/site/node_modules/trusted.js', 'utf8')),
        overwrite: attempt(() => { fs.writeFileSync('/site/node_modules/trusted.js', 'evil'); return 'written'; }),
        add: attempt(() => { fs.writeFileSync('/site/node_modules/evil.js', 'evil'); return 'written'; }),
      }));
    `);
    const run = await runSandboxed({ workspace, dependencies: deps, command: ['node', 'probe.cjs'], network: 'none' });
    const report = JSON.parse(run.output.trim().split('\n').pop()!) as Record<string, string>;

    expect(report).toEqual({ read: 'trusted', overwrite: 'error:EROFS', add: 'error:EROFS' });
    expect(await readFile(join(deps, 'trusted.js'), 'utf8')).toBe('trusted');
  }, 120_000);

  it('cannot reach a Docker or container control socket, and holds no capabilities', async () => {
    const { report } = await probe(`${HELPERS}
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      console.log(JSON.stringify({
        sockets: ['/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock'].filter((p) => fs.existsSync(p)),
        daemon: await tcp('172.17.0.1', 2375),
        capEff: /CapEff:\\s*(\\w+)/.exec(status)[1],
        noNewPrivs: /NoNewPrivs:\\s*(\\d)/.exec(status)[1],
      }));
    `);

    expect(report.sockets).toEqual([]);
    expect(report.daemon).not.toBe('connected');
    expect(report.capEff).toBe('0000000000000000');
    expect(report.noNewPrivs).toBe('1');
  }, 120_000);
});

describe('network isolation', () => {
  let report: Record<string, unknown>;

  beforeAll(async () => {
    ({ report } = await probe(`${HELPERS}
      console.log(JSON.stringify({
        directIp: await tcp('1.1.1.1', 443),
        directFonts: await tcp('fonts.googleapis.com', 443),
        dns: await dns.lookup('example.com').then((r) => r.address, (e) => 'error:' + e.code),
        metadata: await tcp('169.254.169.254', 80),
        hostGateway: await tcp('172.17.0.1', 27018),
        proxyOther: await viaProxy('example.com:443'),
        proxyMetadata: await viaProxy('169.254.169.254:80'),
        proxyFontsWrongPort: await viaProxy('fonts.googleapis.com:80'),
        proxyFonts: await viaProxy('fonts.googleapis.com:443'),
      }));
    `));
  }, 120_000);

  it('a direct network request is blocked', () => {
    expect(report.directIp).not.toBe('connected');
    expect(report.directFonts).not.toBe('connected');
    expect(report.dns).toMatch(/^error:/);
    expect(report.hostGateway).not.toBe('connected');
  });

  it('the cloud metadata endpoint is unreachable, directly or through the proxy', () => {
    expect(report.metadata).not.toBe('connected');
    expect(report.proxyMetadata).toBe('HTTP/1.1 403 Forbidden');
  });

  it('the egress proxy refuses every host but the Google Fonts allowlist', () => {
    expect(report.proxyOther).toBe('HTTP/1.1 403 Forbidden');
    expect(report.proxyFontsWrongPort).toBe('HTTP/1.1 403 Forbidden');
    expect(report.proxyFonts).toBe('HTTP/1.1 200 Connection Established');
  });

  it('with no network, not even the proxy is reachable', async () => {
    const { report: offline } = await probe(`${HELPERS}
      console.log(JSON.stringify({ proxy: await viaProxy('fonts.googleapis.com:443'), directIp: await tcp('1.1.1.1', 443) }));
    `, { network: 'none' });

    expect(offline.proxy).toMatch(/^error:/);
    expect(offline.directIp).not.toBe('connected');
  }, 120_000);
});

describe('process privileges and resource limits', () => {
  it('runs as the restricted, non-root user', async () => {
    const { report } = await probe(`console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid() }));`, { network: 'none' });

    expect(report.uid).not.toBe(0);
    expect(report).toEqual(sandboxUser());
  }, 120_000);

  it('the memory limit is configured, and enforced by killing the process', async () => {
    const { report } = await probe(`const fs = require('node:fs');
      console.log(JSON.stringify({ max: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), swap: fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim() }));
    `, { network: 'none' });
    expect(report.max).toBe(String(DEFAULT_SANDBOX_LIMITS.memoryBytes));
    expect(report.swap).toBe('0');

    const { run } = await probe(`const held = []; for (let i = 0; i < 1024; i++) { held.push(Buffer.alloc(1024 * 1024, 1)); } console.log('survived');`, {
      network: 'none',
      limits: { memoryBytes: 96 * 1024 ** 2 },
    });
    expect(run.oomKilled).toBe(true);
    expect(run.exitCode).toBe(137);
    expect(run.output).not.toContain('survived');
  }, 120_000);

  it('the PID limit is configured, and enforced against a fork loop', async () => {
    const { report } = await probe(`const fs = require('node:fs'); const cp = require('node:child_process');
      const max = fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim();
      let started = 0, refused = 0;
      for (let i = 0; i < 200; i++) {
        try { const c = cp.spawn('sleep', ['30'], { stdio: 'ignore' }); c.on('error', () => {}); if (c.pid) started++; else refused++; } catch { refused++; }
      }
      console.log(JSON.stringify({ max, started, refused }));
      process.exit(0);
    `, { network: 'none', limits: { pids: 32 } });

    expect(report.max).toBe('32');
    expect(Number(report.started)).toBeLessThan(32);
    expect(Number(report.refused)).toBeGreaterThan(0);
  }, 120_000);
});

describe('cancellation', () => {
  it('the wall-clock timeout terminates the run and removes the container', async () => {
    const started = Date.now();
    const { run } = await probe(`setInterval(() => {}, 1000);`, { network: 'none', limits: { timeoutMs: 2_000 } });

    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await sandboxContainers()).toEqual([]);
  }, 120_000);

  it('AbortSignal terminates the run, and no descendant process survives it', async () => {
    const workspace = await mkdtemp(join(root, 'ws-'));
    const marker = 'sleep 7391';
    await writeFile(join(workspace, 'probe.cjs'), `
      const cp = require('node:child_process');
      cp.spawn('sh', ['-c', 'sleep 7391 & sleep 7391 & wait'], { detached: true, stdio: 'ignore' }).unref();
      require('node:fs').writeFileSync('/site/started', '1');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const running = runSandboxed({ workspace, command: ['node', 'probe.cjs'], network: 'font-egress', signal: controller.signal });

    const deadline = Date.now() + 60_000;
    while (!((await exists(join(workspace, 'started'))) && (await hostProcesses()).includes(marker))) {
      if (Date.now() > deadline) throw new Error('probe never started its descendants');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect((await hostProcesses()).split(marker).length - 1).toBeGreaterThanOrEqual(2);

    const reason = new Error('lease lost');
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);

    expect(await hostProcesses()).not.toContain(marker);
    expect(await sandboxContainers()).toEqual([]);
    expect(await sandboxNetworks()).toEqual([]);
  }, 120_000);

  it('an already-aborted signal starts nothing', async () => {
    const workspace = await mkdtemp(join(root, 'ws-'));
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);

    await expect(runSandboxed({ workspace, command: ['node', '-e', '1'], network: 'none', signal: controller.signal })).rejects.toBe(reason);
    expect(await sandboxContainers()).toEqual([]);
  });
});

describe('output', () => {
  it('is bounded however much the untrusted process writes', async () => {
    const { run } = await probe(`
      const chunk = 'x'.repeat(1024) + '\\n';
      for (let i = 0; i < 4096; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }
      // Two streams interleave in any order; let both drain before the line the tail must keep.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      process.stdout.write('the-final-line\\n');
    `, { network: 'none', limits: { outputBytes: 64 * 1024 } });

    expect(run.exitCode).toBe(0);
    expect(Buffer.byteLength(run.output)).toBeLessThanOrEqual(64 * 1024 + 8);
    expect(run.output.startsWith('…\n')).toBe(true);
    expect(run.output).toContain('the-final-line');
  }, 120_000);

  it('leaves no sandbox container or network behind', async () => {
    expect(await sandboxContainers()).toEqual([]);
    expect(await sandboxNetworks()).toEqual([]);
  });
});
