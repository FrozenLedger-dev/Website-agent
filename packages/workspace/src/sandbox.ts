/**
 * The least-privilege sandbox untrusted website code executes in.
 *
 * `next build` executes the model's code: a server component runs during
 * prerender, a config module runs at load, a PostCSS plugin runs per file. Run
 * on the host, that code held every privilege the harness holds — its
 * environment (model, Mongo and Vercel credentials), its filesystem (the
 * repository, the home directory, every other project) and an open network.
 *
 * Here it runs in a disposable container instead, and nowhere else:
 *
 * - **Environment** — an explicit allowlist ({@link sandboxEnvironment}). The
 *   harness environment is never forwarded, not even to the `docker` client
 *   beyond what it needs to reach the daemon.
 * - **Filesystem** — a read-only root filesystem, a size-capped `/tmp`, the
 *   disposable workspace mounted read-write at `/site`, and the trusted
 *   dependency tree mounted read-only over `/site/node_modules`. Nothing else
 *   of the host is mounted: no repository, no home directory, no socket.
 * - **Network** — none by default. A build needs Google Fonts (`next/font/google`
 *   self-hosts brand faces into the export at build time), so a build may use
 *   `font-egress`: a per-run internal network with no route out, whose only
 *   reachable peer is a harness-owned CONNECT proxy that forwards to exactly
 *   {@link FONT_EGRESS_ALLOWLIST} and refuses everything else, metadata
 *   endpoints included.
 * - **Privileges** — a non-root user, every capability dropped,
 *   `no-new-privileges`, and explicit memory, CPU, PID and wall-clock limits.
 * - **Cancellation** — timeout and abort kill the container, which is its
 *   whole PID namespace: no descendant of the untrusted code survives it. The
 *   container is created before it is started, so there is never a moment in
 *   which cancellation could miss one that is still being created.
 * - **Output** — bounded while captured and sanitized before it is returned.
 *
 * Dependencies are never installed from anything the model wrote:
 * {@link prepareTrustedDependencies} installs from the scaffold's own manifest
 * and lockfile, on the host, before and apart from any candidate.
 *
 * This module runs commands. It knows nothing of jobs, acceptance, promotion,
 * release or project state, and it grants none of them: a clean exit here is a
 * fact about one process, never a verdict on a candidate.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Pinned by digest: the runtime untrusted code sees is the one that was reviewed. */
export const SANDBOX_IMAGE =
  'node:20.18.0-bookworm-slim@sha256:28fbbb764069c698ead61d6a739a7615e8f0e07a4b8fe1473ceca70c1c3d6aaa';

/** The only hosts a build may reach, and only through the egress proxy. */
export const FONT_EGRESS_ALLOWLIST = ['fonts.googleapis.com:443', 'fonts.gstatic.com:443'] as const;

export const EGRESS_PROXY_NAME = 'statxai-sandbox-egress';
const EGRESS_PROXY_PORT = 3128;

/** Every container and network this module creates carries this label. */
export const SANDBOX_LABEL = 'statxai.sandbox';

/** `none`: no network interface beyond loopback. `font-egress`: Google Fonts through the proxy, nothing else. */
export type SandboxNetwork = 'none' | 'font-egress';

export interface SandboxLimits {
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pids: number;
  readonly timeoutMs: number;
  readonly tmpBytes: number;
  /** Captured output beyond this is dropped from the head; the tail is what diagnoses a failure. */
  readonly outputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 4 * 1024 ** 3,
  cpus: 2,
  // Counts threads as well as processes: `next build` runs a worker pool and
  // Turbopack's thread pool, well under this; a fork bomb is not.
  pids: 1024,
  timeoutMs: 10 * 60 * 1000,
  tmpBytes: 1024 ** 3,
  outputBytes: 256 * 1024,
};

export interface SandboxRunRequest {
  /** Host directory mounted read-write at `/site`. Disposable: the caller owns and removes it. */
  readonly workspace: string;
  /** Host `node_modules` mounted read-only at `/site/node_modules`. */
  readonly dependencies?: string;
  /** Harness-chosen argv, run with `/site` as the working directory. */
  readonly command: readonly string[];
  readonly network: SandboxNetwork;
  readonly limits?: Partial<SandboxLimits>;
  readonly signal?: AbortSignal;
}

export interface SandboxRunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
  readonly durationMs: number;
  /** Combined stdout and stderr, bounded and sanitized. */
  readonly output: string;
}

/** The sandbox itself could not be provided. Never a verdict on the code that would have run in it. */
export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailable';
  }
}

/** A sandbox container outlived its run. Raised rather than leaving untrusted code running. */
export class SandboxCleanupFailed extends Error {
  constructor(readonly container: string) {
    super(`Sandbox container ${container} could not be removed`);
    this.name = 'SandboxCleanupFailed';
  }
}

/**
 * The complete environment untrusted code runs with. Built, never filtered:
 * nothing reaches it from the harness environment, so no secret can.
 */
export function sandboxEnvironment(network: SandboxNetwork): Record<string, string> {
  return {
    HOME: '/tmp',
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    // A production build must say so explicitly: inheriting the platform's
    // NODE_ENV=development puts a development React inside a production
    // prerender, which fails with a null `useContext` naming neither cause nor file.
    NODE_ENV: 'production',
    ...(network === 'font-egress' ? { HTTPS_PROXY: `http://${EGRESS_PROXY_NAME}:${EGRESS_PROXY_PORT}` } : {}),
  };
}

/** Never root: the harness's own unprivileged ids, or `nobody` when the harness itself is root. */
export function sandboxUser(): { uid: number; gid: number } {
  const uid = process.getuid?.() ?? 65534;
  const gid = process.getgid?.() ?? 65534;
  return uid === 0 ? { uid: 65534, gid: 65534 } : { uid, gid };
}

export interface SandboxContainerSpec {
  readonly name: string;
  /** `none`, or the per-run internal network. */
  readonly networkName: string;
  readonly workspace: string;
  readonly dependencies?: string;
  readonly command: readonly string[];
  readonly limits: SandboxLimits;
  readonly env: Readonly<Record<string, string>>;
  readonly user: { uid: number; gid: number };
}

/** `docker create` arguments for one run — every isolation property, in one reviewable place. */
export function sandboxCreateArgs(spec: SandboxContainerSpec): string[] {
  const { limits } = spec;
  return [
    'create',
    '--name', spec.name,
    '--label', `${SANDBOX_LABEL}=run`,
    '--network', spec.networkName,
    '--user', `${spec.user.uid}:${spec.user.gid}`,
    '--read-only',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpBytes}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', String(limits.memoryBytes),
    // Equal to --memory: no swap to spill into past the limit.
    '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--pids-limit', String(limits.pids),
    '--mount', bindMount(spec.workspace, '/site', false),
    ...(spec.dependencies !== undefined ? ['--mount', bindMount(spec.dependencies, '/site/node_modules', true)] : []),
    '--workdir', '/site',
    ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    SANDBOX_IMAGE,
    ...spec.command,
  ];
}

function bindMount(source: string, target: string, readonly: boolean): string {
  // `--mount` is comma-separated; a source containing one could smuggle options.
  if (!isAbsolute(source) || /[,\n\r\0]/.test(source)) throw new SandboxUnavailable('Refusing an unsafe sandbox mount source');
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

/** What the `docker` client itself needs to reach the daemon, and nothing else. */
const DOCKER_CLIENT_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

function dockerClientEnv(): NodeJS.ProcessEnv {
  return pickEnv(DOCKER_CLIENT_ENV);
}

/** A child environment holding exactly the named harness variables, plus `extra`. */
function pickEnv(keys: readonly string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: readonly string[], timeoutMs = 60_000): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { env: dockerClientEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
      },
    );
  });
}

let imageReady: Promise<void> | null = null;

/** Pull the pinned image as a trusted step, once — a run never pulls. */
export function ensureSandboxImage(): Promise<void> {
  imageReady ??= (async () => {
    const present = await docker(['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE]);
    if (present.code === 0) return;
    const pulled = await docker(['pull', '--quiet', SANDBOX_IMAGE], 10 * 60 * 1000);
    if (pulled.code !== 0) throw new SandboxUnavailable(`Sandbox image unavailable: ${sanitizeSandboxOutput(pulled.stderr)}`);
  })().catch((error: unknown) => {
    imageReady = null;
    throw error instanceof SandboxUnavailable ? error : new SandboxUnavailable(`Docker is unavailable: ${String(error)}`);
  });
  return imageReady;
}

/**
 * The egress proxy: HTTPS CONNECT to the allowlist, nothing else — no plain
 * HTTP, no other host, no other port, no IP literal. Trusted harness code; it
 * runs in its own locked-down container because it is the one component
 * attached to both the sandbox networks and the outside.
 */
export const EGRESS_PROXY_SCRIPT = `
const http = require('node:http');
const net = require('node:net');
const allowed = new Set(${JSON.stringify(FONT_EGRESS_ALLOWLIST)});
const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
server.on('connect', (req, client, head) => {
  const target = String(req.url || '').toLowerCase();
  if (!allowed.has(target)) { client.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n'); return; }
  const at = target.lastIndexOf(':');
  const upstream = net.connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) }, () => {
    client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  for (const socket of [upstream, client]) socket.setTimeout(60000, () => socket.destroy());
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.on('close', () => upstream.destroy());
});
server.on('clientError', (_error, socket) => socket.destroy());
server.listen(${EGRESS_PROXY_PORT}, '0.0.0.0');
`;

const EGRESS_PROXY_VERSION = createHash('sha256').update(SANDBOX_IMAGE).update(EGRESS_PROXY_SCRIPT).digest('hex').slice(0, 16);

let proxyStarting: Promise<void> | null = null;

async function ensureEgressProxy(): Promise<void> {
  const state = await docker([
    'inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${SANDBOX_LABEL}.proxy"}}`, EGRESS_PROXY_NAME,
  ]);
  if (state.code === 0 && state.stdout.trim() === `true ${EGRESS_PROXY_VERSION}`) return;

  proxyStarting ??= (async () => {
    await docker(['rm', '--force', EGRESS_PROXY_NAME]);
    const started = await docker([
      'run', '--detach',
      '--name', EGRESS_PROXY_NAME,
      '--label', `${SANDBOX_LABEL}.proxy=${EGRESS_PROXY_VERSION}`,
      '--restart', 'unless-stopped',
      '--network', 'bridge',
      '--user', '65534:65534',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', String(128 * 1024 ** 2),
      '--pids-limit', '64',
      SANDBOX_IMAGE,
      'node', '-e', EGRESS_PROXY_SCRIPT,
    ]);
    // Another harness process may have won the race to start the same proxy.
    if (started.code !== 0) {
      const again = await docker(['inspect', '--format', `{{index .Config.Labels "${SANDBOX_LABEL}.proxy"}}`, EGRESS_PROXY_NAME]);
      if (again.code !== 0 || again.stdout.trim() !== EGRESS_PROXY_VERSION) {
        throw new SandboxUnavailable(`Sandbox egress proxy unavailable: ${sanitizeSandboxOutput(started.stderr)}`);
      }
    }
  })().finally(() => {
    proxyStarting = null;
  });
  await proxyStarting;
}

/** A network of this run's own: internal (no route out), shared only with the proxy. */
async function openEgressNetwork(name: string): Promise<void> {
  await ensureEgressProxy();
  const created = await docker(['network', 'create', '--internal', '--label', `${SANDBOX_LABEL}=network`, name]);
  if (created.code !== 0) throw new SandboxUnavailable(`Sandbox network unavailable: ${sanitizeSandboxOutput(created.stderr)}`);
  const connected = await docker(['network', 'connect', name, EGRESS_PROXY_NAME]);
  if (connected.code !== 0) {
    await docker(['network', 'rm', name]);
    throw new SandboxUnavailable(`Sandbox egress proxy unavailable: ${sanitizeSandboxOutput(connected.stderr)}`);
  }
}

async function closeEgressNetwork(name: string): Promise<void> {
  await docker(['network', 'disconnect', '--force', name, EGRESS_PROXY_NAME]);
  await docker(['network', 'rm', name]);
}

/** SIGKILL to the container's init, which the kernel extends to its whole PID namespace. */
function killContainer(name: string): Promise<DockerResult> {
  return docker(['kill', '--signal', 'KILL', name]);
}

async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name]);
  const remaining = await docker(['ps', '--all', '--quiet', '--filter', `name=^${name}$`]);
  if (remaining.code !== 0 || remaining.stdout.trim() !== '') throw new SandboxCleanupFailed(name);
}

/** Keeps the last `limit` bytes of a stream — memory stays bounded however much is written. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const excess = this.size - this.limit;
      const head = this.chunks[0]!;
      this.truncated = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `…\n${body}` : body;
  }
}

/**
 * Run one harness-chosen command against untrusted files, inside the sandbox.
 *
 * Resolves with the exit status, including a failing one, a timeout or an
 * out-of-memory kill — those are facts about the untrusted code. Rejects with
 * the abort reason when `signal` aborts, and with {@link SandboxUnavailable}
 * when the sandbox itself cannot be provided. Either way, by the time it
 * settles the container and its network are gone.
 */
export async function runSandboxed(request: SandboxRunRequest): Promise<SandboxRunResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...request.limits };
  request.signal?.throwIfAborted();
  await ensureSandboxImage();

  const name = `statxai-sbx-${randomBytes(8).toString('hex')}`;
  const started = Date.now();
  const paths = [
    { path: request.workspace, replacement: '/site' },
    ...(request.dependencies !== undefined ? [{ path: request.dependencies, replacement: '/site/node_modules' }] : []),
  ];
  let networkOpen = false;
  let created = false;

  try {
    if (request.network === 'font-egress') {
      await openEgressNetwork(name);
      networkOpen = true;
    }

    const create = await docker(
      sandboxCreateArgs({
        name,
        networkName: request.network === 'font-egress' ? name : 'none',
        workspace: request.workspace,
        ...(request.dependencies !== undefined ? { dependencies: request.dependencies } : {}),
        command: request.command,
        limits,
        env: sandboxEnvironment(request.network),
        user: sandboxUser(),
      }),
    );
    if (create.code !== 0) throw new SandboxUnavailable(`Sandbox could not be created: ${sanitizeSandboxOutput(create.stderr, paths)}`);
    created = true;
    request.signal?.throwIfAborted();

    const attached = await attach(name, limits, request.signal);
    if (attached.aborted) throw request.signal?.reason ?? new Error('Sandboxed run aborted');

    const state = await docker(['inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}', name]);
    const [exit, oom] = state.stdout.trim().split(' ');
    return {
      exitCode: attached.timedOut || state.code !== 0 ? null : Number(exit),
      timedOut: attached.timedOut,
      oomKilled: oom === 'true',
      durationMs: Date.now() - started,
      output: sanitizeSandboxOutput(attached.output, paths),
    };
  } finally {
    try {
      if (created) await removeContainer(name);
    } finally {
      // Even when the container refuses removal, its network is not left behind.
      if (networkOpen) await closeEgressNetwork(name);
    }
  }
}

function attach(
  name: string,
  limits: SandboxLimits,
  signal: AbortSignal | undefined,
): Promise<{ output: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const output = new TailBuffer(limits.outputBytes);
    let timedOut = false;
    let aborted = false;

    const child = spawn('docker', ['start', '--attach', name], { env: dockerClientEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));

    // Both end the container, not the client: killing `docker start` would
    // leave everything it started running.
    const timer = setTimeout(() => {
      timedOut = true;
      void killContainer(name);
    }, limits.timeoutMs);
    const onAbort = () => {
      aborted = true;
      void killContainer(name);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      finish();
      reject(new SandboxUnavailable(`Docker is unavailable: ${error.message}`));
    });
    child.on('close', () => {
      finish();
      resolve({ output: output.text(), timedOut, aborted });
    });
  });
}

/** Keys whose values are credentials wherever they appear. */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|URI|DSN|COOKIE|SESSION|PRIVATE)/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Make sandbox output safe to hand to a model or a log.
 *
 * - host paths the run was given are rewritten to what the sandbox called them;
 * - any other home, root-home or temp path is replaced wholesale;
 * - the value of every secret-shaped harness environment variable is redacted
 *   wherever it appears, as is the right-hand side of any `SECRET_NAME=value`
 *   line and the userinfo of any credentialed URL.
 *
 * Deterministic, so a diagnosis is the same text every time it is produced.
 */
export function sanitizeSandboxOutput(
  text: string,
  paths: readonly { path: string; replacement: string }[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text;

  const secrets = Object.entries(env)
    .filter(([key, value]) => SECRET_KEY.test(key) && value !== undefined && value.length >= 6)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('[redacted]');

  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  out = out.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S.*$/gm, (line: string, name: string) =>
    SECRET_KEY.test(name) ? `${name}=[redacted]` : line,
  );

  const hostPaths = [...paths].filter((p) => p.path.length > 1).sort((a, b) => b.path.length - a.path.length);
  for (const { path, replacement } of hostPaths) out = out.split(path).join(replacement);

  const roots = [process.cwd(), homedir(), tmpdir(), '/home/', '/root/', '/Users/']
    .filter((root) => root.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    out = out.replace(new RegExp(`${escapeRegExp(root)}[^\\s'"\`)\\\\]*`, 'g'), '<host-path>');
  }
  return out;
}

/** The files that define the trusted dependency tree — the scaffold's, never a candidate's. */
export const TRUSTED_MANIFEST_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;

const preparing = new Map<string, Promise<string>>();

/**
 * Install the scaffold's dependency tree, once per manifest, and return its
 * `node_modules` for mounting read-only into a sandbox.
 *
 * A trusted step: the only inputs are {@link TRUSTED_MANIFEST_FILES} read from
 * `manifestRoot` — the platform template — so nothing a candidate wrote can
 * add a dependency, a script or a registry. The install sees an explicit
 * environment, never the harness's. The cache entry is keyed by the manifest's
 * content and appears atomically, so a concurrent or interrupted install is
 * never mistaken for a finished one.
 */
export function prepareTrustedDependencies(manifestRoot: string, cacheRoot: string): Promise<string> {
  const key = `${manifestRoot}\0${cacheRoot}`;
  let pending = preparing.get(key);
  if (!pending) {
    pending = installTrustedDependencies(manifestRoot, cacheRoot).finally(() => preparing.delete(key));
    preparing.set(key, pending);
  }
  return pending;
}

async function installTrustedDependencies(manifestRoot: string, cacheRoot: string): Promise<string> {
  const hash = createHash('sha256').update(`${process.platform}\0${process.arch}\0`);
  const manifests: [string, Buffer][] = [];
  for (const file of TRUSTED_MANIFEST_FILES) {
    const contents = await readFile(join(manifestRoot, file));
    hash.update(`${file}\0`).update(contents).update('\0');
    manifests.push([file, contents]);
  }
  const target = join(cacheRoot, `deps-${hash.digest('hex').slice(0, 32)}`);
  const ready = join(target, '.statxai-ready');
  if (await exists(ready)) return join(target, 'node_modules');

  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(cacheRoot, '.deps-'));
  try {
    for (const [file, contents] of manifests) await writeFile(join(staging, file), contents);
    await new Promise<void>((resolve, reject) => {
      execFile(
        'pnpm',
        // --frozen-lockfile: the dependency graph is the one proven to build;
        // `^` ranges never resolve forward into a transitive change.
        ['install', '--frozen-lockfile', '--prefer-offline'],
        {
          cwd: staging,
          env: pickEnv(['PATH', 'HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PNPM_HOME'], { CI: '1' }),
          timeout: 10 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, _stdout, stderr) =>
          error ? reject(new SandboxUnavailable(`Trusted dependency install failed: ${sanitizeSandboxOutput(String(stderr || error.message)).slice(-2000)}`)) : resolve(),
      );
    });
    await writeFile(join(staging, '.statxai-ready'), '');
    await rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another process finished the same install first; theirs is identical.
      if (!(await exists(ready))) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return join(target, 'node_modules');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
