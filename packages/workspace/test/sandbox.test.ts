/**
 * The sandbox's isolation properties as the harness asks Docker for them —
 * no Docker needed. `sandbox.integration.test.ts` proves Docker enforces them.
 */
import { homedir, tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SANDBOX_LIMITS,
  EGRESS_PROXY_NAME,
  EGRESS_PROXY_SCRIPT,
  FONT_EGRESS_ALLOWLIST,
  SANDBOX_IMAGE,
  sandboxCreateArgs,
  sandboxEnvironment,
  sandboxUser,
  sanitizeSandboxOutput,
  type SandboxContainerSpec,
} from '../src/index.js';

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-fake-openai-0123456789',
  VERCEL_TOKEN: 'vercel-fake-token-0123456789',
  MONGODB_URI: 'mongodb://harness:fake-mongo-password@db.internal:27017/statxai',
  ANTHROPIC_API_KEY: 'sk-ant-fake-0123456789',
};

function spec(overrides: Partial<SandboxContainerSpec> = {}): SandboxContainerSpec {
  return {
    name: 'statxai-sbx-unit',
    networkName: 'none',
    workspace: '/var/lib/statxai-sandbox/runs/build-x/site',
    dependencies: '/var/lib/statxai-sandbox/deps-x/node_modules',
    command: ['node', 'node_modules/next/dist/bin/next', 'build'],
    limits: DEFAULT_SANDBOX_LIMITS,
    env: sandboxEnvironment('font-egress'),
    user: sandboxUser(),
    ...overrides,
  };
}

/** Every value passed to `flag`, in order. */
function values(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sandbox environment', () => {
  it('is an explicit allowlist — exactly these variables, whatever the harness holds', () => {
    for (const [key, value] of Object.entries(FAKE_SECRETS)) vi.stubEnv(key, value);

    expect(sandboxEnvironment('none')).toEqual({
      HOME: '/tmp',
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'production',
    });
    expect(sandboxEnvironment('font-egress')).toEqual({
      HOME: '/tmp',
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'production',
      HTTPS_PROXY: `http://${EGRESS_PROXY_NAME}:3128`,
    });
  });

  it('is the only environment the container is created with, and carries no harness secret', () => {
    for (const [key, value] of Object.entries(FAKE_SECRETS)) vi.stubEnv(key, value);
    const args = sandboxCreateArgs(spec());

    expect(values(args, '--env')).toEqual([
      'HOME=/tmp',
      'CI=1',
      'NEXT_TELEMETRY_DISABLED=1',
      'NODE_ENV=production',
      `HTTPS_PROXY=http://${EGRESS_PROXY_NAME}:3128`,
    ]);
    for (const flag of ['-e', '--env-file']) expect(args).not.toContain(flag);
    const joined = args.join('\n');
    for (const [key, value] of Object.entries(FAKE_SECRETS)) {
      expect(joined).not.toContain(key);
      expect(joined).not.toContain(value);
    }
  });
});

describe('sandbox container arguments', () => {
  it('mounts exactly the disposable workspace read-write and the trusted dependencies read-only', () => {
    const args = sandboxCreateArgs(spec());

    expect(values(args, '--mount')).toEqual([
      'type=bind,source=/var/lib/statxai-sandbox/runs/build-x/site,target=/site',
      'type=bind,source=/var/lib/statxai-sandbox/deps-x/node_modules,target=/site/node_modules,readonly',
    ]);
    for (const flag of ['-v', '--volume', '--volumes-from', '--device', '--privileged']) expect(args).not.toContain(flag);
  });

  it('exposes no repository, home directory or privileged socket', () => {
    const joined = sandboxCreateArgs(spec()).join('\n');

    expect(joined).not.toContain(process.cwd());
    expect(joined).not.toContain(homedir());
    expect(joined).not.toMatch(/docker\.sock|containerd\.sock|podman\.sock/);
  });

  it('refuses a mount source that could smuggle mount options', () => {
    expect(() => sandboxCreateArgs(spec({ workspace: '/tmp/site,target=/etc' }))).toThrow(/unsafe sandbox mount/);
    expect(() => sandboxCreateArgs(spec({ workspace: 'relative/site' }))).toThrow(/unsafe sandbox mount/);
  });

  it('runs with the given network only — none, or the per-run internal network', () => {
    expect(values(sandboxCreateArgs(spec()), '--network')).toEqual(['none']);
    expect(values(sandboxCreateArgs(spec({ networkName: 'statxai-sbx-run' })), '--network')).toEqual(['statxai-sbx-run']);
    for (const flag of ['--net', '--add-host', '--dns', '--publish', '-p']) expect(sandboxCreateArgs(spec())).not.toContain(flag);
  });

  it('runs non-root, read-only, with every capability dropped and no privilege escalation', () => {
    const args = sandboxCreateArgs(spec({ user: { uid: 1000, gid: 1000 } }));

    expect(values(args, '--user')).toEqual(['1000:1000']);
    expect(args).toContain('--read-only');
    expect(values(args, '--cap-drop')).toEqual(['ALL']);
    expect(values(args, '--cap-add')).toEqual([]);
    expect(values(args, '--security-opt')).toEqual(['no-new-privileges']);
    for (const flag of ['--pid', '--ipc', '--uts', '--userns', '--cgroupns']) expect(args).not.toContain(flag);
    expect(values(args, '--tmpfs')).toEqual([`/tmp:rw,noexec,nosuid,nodev,size=${DEFAULT_SANDBOX_LIMITS.tmpBytes}`]);
  });

  it('applies memory (without swap), CPU and PID limits', () => {
    const limits = { ...DEFAULT_SANDBOX_LIMITS, memoryBytes: 123_456_789, cpus: 1.5, pids: 77 };
    const args = sandboxCreateArgs(spec({ limits }));

    expect(values(args, '--memory')).toEqual(['123456789']);
    expect(values(args, '--memory-swap')).toEqual(['123456789']);
    expect(values(args, '--cpus')).toEqual(['1.5']);
    expect(values(args, '--pids-limit')).toEqual(['77']);
  });

  it('ships default limits for every dimension', () => {
    expect(DEFAULT_SANDBOX_LIMITS.memoryBytes).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.cpus).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.pids).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.outputBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('runs the digest-pinned image, then exactly the harness command', () => {
    const args = sandboxCreateArgs(spec());

    expect(SANDBOX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(args.slice(args.indexOf(SANDBOX_IMAGE))).toEqual([SANDBOX_IMAGE, 'node', 'node_modules/next/dist/bin/next', 'build']);
    expect(args[0]).toBe('create');
    expect(args).not.toContain('--rm');
  });
});

/** `getuid`/`getgid` are optional on `process` (absent on Windows); spied through a required-typed view. */
const ids = process as unknown as { getuid: () => number; getgid: () => number };

describe('sandbox user', () => {
  it('is the harness’s own unprivileged ids', () => {
    vi.spyOn(ids, 'getuid').mockReturnValue(1234);
    vi.spyOn(ids, 'getgid').mockReturnValue(4321);
    expect(sandboxUser()).toEqual({ uid: 1234, gid: 4321 });
  });

  it('is nobody, never root, when the harness runs as root', () => {
    vi.spyOn(ids, 'getuid').mockReturnValue(0);
    vi.spyOn(ids, 'getgid').mockReturnValue(0);
    expect(sandboxUser()).toEqual({ uid: 65534, gid: 65534 });
  });
});

describe('egress proxy', () => {
  it('allows exactly the Google Fonts hosts on 443', () => {
    expect(FONT_EGRESS_ALLOWLIST).toEqual(['fonts.googleapis.com:443', 'fonts.gstatic.com:443']);
    expect(EGRESS_PROXY_SCRIPT).toContain(JSON.stringify(FONT_EGRESS_ALLOWLIST));
    expect(EGRESS_PROXY_SCRIPT).toContain('if (!allowed.has(target))');
  });
});

describe('sandbox output sanitizer', () => {
  const env = { ...FAKE_SECRETS, PATH: '/usr/bin', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it('keeps ordinary diagnostics intact', () => {
    const text = "./app/page.tsx:3:7\nType error: Type 'number' is not assignable to type 'string'.";
    expect(sanitizeSandboxOutput(text, [], env)).toBe(text);
  });

  it('rewrites the paths the run was given to what the sandbox called them', () => {
    const workspace = '/srv/statxai/sandbox/runs/build-abc/site';
    const text = `Error: Cannot find module '${workspace}/app/missing' from ${workspace}/app/page.tsx`;

    expect(sanitizeSandboxOutput(text, [{ path: workspace, replacement: '/site' }], env)).toBe(
      "Error: Cannot find module '/site/app/missing' from /site/app/page.tsx",
    );
  });

  it('removes home, repository and temp paths it was not told about', () => {
    const text = [
      `at ${homedir()}/.ssh/id_ed25519`,
      `at ${process.cwd()}/packages/workspace/src/sandbox.ts:12`,
      `at ${tmpdir()}/statxai-fb-validate-x/app/page.tsx`,
      'at /home/someone/project/.env.local',
      'at /root/.docker/config.json',
    ].join('\n');
    const out = sanitizeSandboxOutput(text, [], env);

    for (const leaked of [homedir(), process.cwd(), `${tmpdir()}/`, '/home/', '/root/']) expect(out).not.toContain(leaked);
    expect(out.match(/<host-path>/g)).toHaveLength(5);
  });

  it('ends a replaced path at an escaped newline, keeping the text after it', () => {
    const out = sanitizeSandboxOutput('{"env":"HOME=/home/someone/x\\nNODE_ENV=production"}', [], env);
    expect(out).toBe('{"env":"HOME=<host-path>\\nNODE_ENV=production"}');
  });

  it('redacts every secret-shaped harness value wherever it appears', () => {
    const text = `request failed with ${FAKE_SECRETS.OPENAI_API_KEY}; token ${FAKE_SECRETS.VERCEL_TOKEN}; ${FAKE_SECRETS.MONGODB_URI}`;
    const out = sanitizeSandboxOutput(text, [], env);

    for (const secret of Object.values(FAKE_SECRETS)) expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('redacts environment dumps and credentialed URLs it holds no value for', () => {
    const text = [
      'STRIPE_SECRET_KEY=sk_live_unknown_to_the_harness',
      'export GITHUB_TOKEN=ghp_unknowntoharness',
      'DATABASE_URL=postgres://user:hunter2@db:5432/app',
      'connecting to https://admin:s3cret@internal.example/',
      'NODE_ENV=production',
    ].join('\n');
    const out = sanitizeSandboxOutput(text, [], env);

    for (const leaked of ['sk_live_unknown_to_the_harness', 'ghp_unknowntoharness', 'hunter2', 's3cret']) expect(out).not.toContain(leaked);
    expect(out).toContain('NODE_ENV=production');
  });
});
