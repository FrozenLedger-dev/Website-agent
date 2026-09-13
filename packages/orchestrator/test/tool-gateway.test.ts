/**
 * The tool gateway and the one real tool it registers.
 *
 * The gateway is tested with fake adapters, so permission is proven without a
 * file system. The filesystem adapter is tested against the real platform
 * scaffold, because what matters about it is what it actually refuses to read.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { ToolId, type ToolId as ToolIdType } from '@statxai/contracts';
import { defaultTemplateRoot } from '@statxai/workspace';
import {
  ToolGateway,
  ToolInputInvalid,
  ToolPermissionDenied,
  ToolUnavailable,
  effectiveTools,
  type ToolAdapter,
  type ToolCallContext,
  type ToolEvidence,
} from '../src/tool-gateway/gateway.js';
import { FILESYSTEM_MAX_FILE_BYTES, FilesystemPathRefused, createScaffoldFilesystemAdapter } from '../src/tool-gateway/filesystem.js';
import { FRONTEND_BACKEND_SUPPORTED_TOOLS } from '../src/job-handlers/frontend-backend.js';

const context = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  projectId: 'proj_tools',
  jobId: 'job_1',
  skill: 'terra-build',
  role: 'frontend_backend',
  allowedTools: ['filesystem'],
  supportedTools: ['filesystem'],
  ...over,
});

function fakeAdapter(tool: ToolIdType, behaviour?: (input: { path: string }, signal?: AbortSignal) => Promise<unknown>) {
  const execute = vi.fn(behaviour ?? (async (input: { path: string }) => ({ read: input.path })));
  const adapter: ToolAdapter<{ path: string }, unknown> = {
    tool,
    input: z.object({ path: z.string() }),
    execute,
    describe: (input) => ({ path: input.path }),
  };
  return { adapter, execute };
}

describe('permission', () => {
  it('executes a permitted, registered tool exactly once and returns its result', async () => {
    const { adapter, execute } = fakeAdapter('filesystem');
    const gateway = new ToolGateway({ adapters: [adapter] });

    await expect(gateway.execute({ tool: 'filesystem', input: { path: 'a' }, context: context() })).resolves.toEqual({ read: 'a' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a tool absent from the job’s allowedTools before any adapter runs — even one the role would use', async () => {
    const { adapter, execute } = fakeAdapter('filesystem');
    const gateway = new ToolGateway({ adapters: [adapter] });

    const error = await gateway.execute({ tool: 'filesystem', input: { path: 'a' }, context: context({ allowedTools: [] }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolPermissionDenied);
    expect((error as ToolPermissionDenied).tool).toBe('filesystem');
    expect(execute).not.toHaveBeenCalled();
  });

  it('a handler narrows the grant: allowed A and B, supported A, effective A only', async () => {
    const fs = fakeAdapter('filesystem');
    const git = fakeAdapter('git');
    const gateway = new ToolGateway({ adapters: [fs.adapter, git.adapter] });
    const ctx = context({ allowedTools: ['filesystem', 'git'], supportedTools: ['filesystem'] });

    expect(effectiveTools(ctx.allowedTools, ctx.supportedTools)).toEqual(['filesystem']);
    await expect(gateway.execute({ tool: 'git', input: { path: 'a' }, context: ctx })).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(git.execute).not.toHaveBeenCalled();
  });

  it('a spec cannot be widened by a handler: supported A and B, allowed A, effective A only', async () => {
    const git = fakeAdapter('git');
    const gateway = new ToolGateway({ adapters: [git.adapter] });
    const ctx = context({ allowedTools: ['filesystem'], supportedTools: ['filesystem', 'git'] });

    await expect(gateway.execute({ tool: 'git', input: { path: 'a' }, context: ctx })).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(git.execute).not.toHaveBeenCalled();
  });

  it('a permitted tool with no adapter is unavailable, not denied, and nothing runs', async () => {
    const { adapter, execute } = fakeAdapter('filesystem');
    const gateway = new ToolGateway({ adapters: [adapter] });
    const ctx = context({ allowedTools: ['test_runner'], supportedTools: ['test_runner'] });

    await expect(gateway.execute({ tool: 'test_runner', input: { path: 'a' }, context: ctx })).rejects.toBeInstanceOf(ToolUnavailable);
    expect(execute).not.toHaveBeenCalled();
  });

  it('input that does not satisfy the tool contract is refused before execution', async () => {
    const { adapter, execute } = fakeAdapter('filesystem');
    const gateway = new ToolGateway({ adapters: [adapter] });
    await expect(gateway.execute({ tool: 'filesystem', input: { path: 42 }, context: context() })).rejects.toBeInstanceOf(ToolInputInvalid);
    expect(execute).not.toHaveBeenCalled();
  });

  it('an execution failure stays an execution failure, distinct from denial', async () => {
    const failure = new Error('disk unavailable');
    const { adapter } = fakeAdapter('filesystem', async () => {
      throw failure;
    });
    const gateway = new ToolGateway({ adapters: [adapter] });
    await expect(gateway.execute({ tool: 'filesystem', input: { path: 'a' }, context: context() })).rejects.toBe(failure);
  });

  it('forwards cancellation to the adapter, and a cancelled call never resolves as a result', async () => {
    const controller = new AbortController();
    const { adapter, execute } = fakeAdapter('filesystem', async (_input, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('lease lost'));
      return { read: 'late' };
    });
    const gateway = new ToolGateway({ adapters: [adapter] });

    await expect(gateway.execute({ tool: 'filesystem', input: { path: 'a' }, context: context(), signal: controller.signal })).rejects.toThrow('lease lost');
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(gateway.execute({ tool: 'filesystem', input: { path: 'a' }, context: context(), signal: controller.signal })).rejects.toThrow('lease lost');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records evidence with safe metadata only — never content or credentials', async () => {
    process.env.VERCEL_TOKEN = 'vercel-secret-token-value';
    const evidence: ToolEvidence[] = [];
    const { adapter } = fakeAdapter('filesystem', async () => ({ content: 'file body with a secret-looking value', token: process.env.VERCEL_TOKEN }));
    const gateway = new ToolGateway({ adapters: [adapter], onEvidence: (e) => evidence.push(e) });

    await gateway.execute({ tool: 'filesystem', input: { path: 'app/layout.tsx' }, context: context() });
    await gateway.execute({ tool: 'git', input: { path: 'x' }, context: context() }).catch(() => undefined);

    expect(evidence.map((e) => [e.tool, e.outcome])).toEqual([['filesystem', 'succeeded'], ['git', 'denied']]);
    expect(evidence[0]).toMatchObject({ projectId: 'proj_tools', jobId: 'job_1', skill: 'terra-build', role: 'frontend_backend', detail: { path: 'app/layout.tsx' } });
    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain('vercel-secret-token-value');
    expect(serialised).not.toContain('file body');
    delete process.env.VERCEL_TOKEN;
  });
});

describe('what is registered', () => {
  it('the frontend_backend handler supports exactly the one executable tool', () => {
    expect(FRONTEND_BACKEND_SUPPORTED_TOOLS).toEqual(['filesystem']);
  });

  it('a gateway refuses to register one tool twice', () => {
    expect(() => new ToolGateway({ adapters: [fakeAdapter('filesystem').adapter, fakeAdapter('filesystem').adapter] })).toThrow();
  });

  it('no control-plane operation is a tool id', () => {
    for (const forbidden of ['promotion', 'acceptance', 'release_publication', 'release_authorization', 'job_transition', 'state_store']) {
      expect(ToolId.options).not.toContain(forbidden);
    }
  });
});

describe('the scaffold filesystem adapter', () => {
  const root = defaultTemplateRoot();
  const adapter = createScaffoldFilesystemAdapter({ root });
  const read = (path: string, signal?: AbortSignal) => adapter.execute({ path }, signal);

  async function fingerprint(dir: string): Promise<string> {
    const hash = createHash('sha256');
    const walk = async (d: string): Promise<void> => {
      for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules') continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else hash.update(full).update(await readFile(full));
      }
    };
    await walk(dir);
    return hash.digest('hex');
  }

  it('returns a scaffold file’s exact contents', async () => {
    const result = await read('components/ui/button.tsx');
    expect(result).toEqual({
      tool: 'filesystem',
      ok: true,
      path: 'components/ui/button.tsx',
      content: await readFile(join(root, 'components/ui/button.tsx'), 'utf8'),
      bytes: (await readFile(join(root, 'components/ui/button.tsx'))).length,
      truncated: false,
    });
  });

  it.each([
    ['traversal', '../package.json'],
    ['nested traversal', 'components/../../package.json'],
    ['absolute', '/etc/passwd'],
    ['absolute-looking site path', '/app/layout.tsx'],
    ['dot segment', './app/layout.tsx'],
    ['hidden file', '.gitignore'],
    ['env file', '.env'],
    ['env file in a folder', 'app/.env.local'],
    ['excluded tree', 'node_modules/react/package.json'],
    ['backslash', 'app\\layout.tsx'],
    // Spellings that path joining would quietly normalise into an authorised file.
    ['empty segment', 'components//ui/button.tsx'],
    ['drive-letter absolute', 'C:/Windows/win.ini'],
  ])('refuses a %s path without normalising it', async (_label, path) => {
    await expect(read(path)).rejects.toBeInstanceOf(FilesystemPathRefused);
  });

  it('refuses a symlink that escapes the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'statxai-fs-tool-'));
    try {
      await mkdir(join(dir, 'root'));
      await writeFile(join(dir, 'secret.txt'), 'outside');
      await symlink(join(dir, 'secret.txt'), join(dir, 'root', 'link.txt'));
      const escaped = createScaffoldFilesystemAdapter({ root: join(dir, 'root') });
      await expect(escaped.execute({ path: 'link.txt' })).rejects.toBeInstanceOf(FilesystemPathRefused);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers a missing file, a directory and a binary file with typed results', async () => {
    expect(await read('app/missing.tsx')).toEqual({ tool: 'filesystem', ok: false, path: 'app/missing.tsx', error: 'not_found' });
    expect(await read('components/ui')).toEqual({ tool: 'filesystem', ok: false, path: 'components/ui', error: 'not_a_file' });
    expect(await read('app/favicon.ico')).toEqual({ tool: 'filesystem', ok: false, path: 'app/favicon.ico', error: 'not_text' });
  });

  it('bounds an oversized file deterministically', async () => {
    const result = await read('pnpm-lock.yaml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(FILESYSTEM_MAX_FILE_BYTES);
    expect(result.bytes).toBeGreaterThan(FILESYSTEM_MAX_FILE_BYTES);
    expect(await read('pnpm-lock.yaml')).toEqual(result);
  });

  it('does not read once cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease lost'));
    await expect(read('app/layout.tsx', controller.signal)).rejects.toThrow('lease lost');
  });

  it('is read-only: the scaffold is byte-identical after reads', async () => {
    const before = await fingerprint(root);
    for (const path of ['app/layout.tsx', 'app/globals.css', 'components/ui/card.tsx', 'package.json']) await read(path);
    expect(await fingerprint(root)).toBe(before);
    expect(Object.keys(adapter).sort()).toEqual(['describe', 'execute', 'input', 'tool']);
  });
});
