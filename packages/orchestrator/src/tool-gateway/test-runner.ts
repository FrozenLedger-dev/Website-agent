/**
 * The `test_runner` tool: measure one proposed build the way the platform
 * measures every build, and tell Terra what it found.
 *
 * Terra chooses what to test — a complete `BuildOutput` — and nothing about
 * how. The candidate is refused unless every file is model-writable, then
 * materialised exactly as the official validator materialises one (a fresh
 * disposable workspace, the platform scaffold, `writeSiteFiles`), then measured
 * by `runDeterministicGates` — the same sandboxed compile and the same gates
 * official validation and canonical evaluation run. There is no second
 * executor: this module starts no process and builds nothing itself.
 *
 * Advisory only. It is given no job engine, store, registry or project
 * workspace, so it cannot record validation, accept, promote, release or
 * change project state — and a passing result is feedback to the model, never
 * evidence to the harness. The candidate Terra finally returns is validated
 * from scratch by the official validator regardless.
 *
 * What comes back is a projection, not the raw build: status, sanitized and
 * bounded compiler diagnostics, and the gate findings — the most severe first —
 * within explicit count, length and size bounds.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TestRunnerInput,
  type BusinessProfile,
  type SitePlan,
  type TestRunnerFinding,
  type TestRunnerResult,
} from '@statxai/contracts';
import {
  ProjectWorkspace,
  SandboxUnavailable,
  WriteOutsideModelScope,
  assertModelWritableFiles,
  contentHash,
  sanitizeSandboxOutput,
  scaffoldSite,
} from '@statxai/workspace';
import { runDeterministicGates } from '../phases/evaluate.js';
import type { ToolAdapter } from './gateway.js';

/** Findings returned per test. A site this platform builds rarely has more than a handful. */
export const TEST_RUNNER_MAX_FINDINGS = 20;
/** Characters per finding message. Gate message templates run 60–111 characters before interpolation. */
export const TEST_RUNNER_MAX_MESSAGE_CHARS = 400;
export const TEST_RUNNER_MAX_LOCATION_CHARS = 160;
/** Compiler diagnostics: the tail, where a build failure is legible. */
export const TEST_RUNNER_MAX_DIAGNOSTIC_CHARS = 3_000;
/** The whole result as fed back to the model. */
export const TEST_RUNNER_MAX_RESULT_BYTES = 12_000;
const MAX_REFUSED_PATHS = 20;
const MAX_PATH_CHARS = 200;

export interface TestRunnerAdapterOptions {
  /** The claimed job's pinned inputs — the gates measure a site against these. */
  readonly profile: BusinessProfile;
  readonly plan: SitePlan;
  /** Where disposable advisory workspaces are created, from trusted harness configuration. */
  readonly workspacesRoot: string;
}

const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function tailClip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - (limit - 1))}`;
}

/** Fit a result within the byte bound by dropping the least severe findings last-first. */
function bounded(result: TestRunnerResult): TestRunnerResult {
  const findings = [...result.findings];
  let truncated = result.truncated;
  let fitted: TestRunnerResult = { ...result, findings, truncated };
  while (Buffer.byteLength(JSON.stringify(fitted), 'utf8') > TEST_RUNNER_MAX_RESULT_BYTES && findings.length > 0) {
    findings.pop();
    truncated = true;
    fitted = { ...result, findings: [...findings], truncated };
  }
  return fitted;
}

function empty(candidateHash: string, status: TestRunnerResult['status']): TestRunnerResult {
  return { tool: 'test_runner', status, passed: false, candidateHash, compile: null, findings: [], findingCount: 0, refusedPaths: [], truncated: false };
}

export function createTestRunnerAdapter(options: TestRunnerAdapterOptions): ToolAdapter<TestRunnerInput, TestRunnerResult> {
  // One advisory build at a time per job: pages built in parallel may each ask,
  // and each sandbox already holds gigabytes and whole CPUs.
  let queue: Promise<unknown> = Promise.resolve();

  async function measure({ candidate }: TestRunnerInput, signal?: AbortSignal): Promise<TestRunnerResult> {
    signal?.throwIfAborted();
    const candidateHash = contentHash(candidate);

    try {
      assertModelWritableFiles(candidate.files);
    } catch (error) {
      if (!(error instanceof WriteOutsideModelScope)) throw error;
      return bounded({
        ...empty(candidateHash, 'refused'),
        refusedPaths: error.paths.slice(0, MAX_REFUSED_PATHS).map((path) => clip(sanitizeSandboxOutput(path), MAX_PATH_CHARS)),
        truncated: error.paths.length > MAX_REFUSED_PATHS,
      });
    }

    await mkdir(options.workspacesRoot, { recursive: true });
    const root = await mkdtemp(join(options.workspacesRoot, 'advisory-'));
    try {
      // The same materialisation the official validator performs.
      const ws = await ProjectWorkspace.open('advisory', root);
      await scaffoldSite(ws.siteRoot);
      await ws.writeSiteFiles(candidate.files);
      signal?.throwIfAborted();

      let measured: Awaited<ReturnType<typeof runDeterministicGates>>;
      try {
        measured = await runDeterministicGates(ws.siteRoot, options.profile, options.plan, signal);
      } catch (error) {
        if (error instanceof SandboxUnavailable && !signal?.aborted) return empty(candidateHash, 'unavailable');
        throw error;
      }
      const { compiled, gateRun } = measured;

      const all: TestRunnerFinding[] = gateRun.findings
        .map((finding) => ({
          gate: clip(finding.gate, 60),
          severity: finding.severity as TestRunnerFinding['severity'],
          location: clip(sanitizeSandboxOutput(finding.location), TEST_RUNNER_MAX_LOCATION_CHARS),
          message: clip(sanitizeSandboxOutput(finding.message), TEST_RUNNER_MAX_MESSAGE_CHARS),
        }))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

      const passed = compiled.ok && gateRun.passed;
      return bounded({
        tool: 'test_runner',
        status: passed ? 'passed' : compiled.limit === 'time' ? 'timed_out' : 'failed',
        passed,
        candidateHash,
        compile: {
          ok: compiled.ok,
          diagnostics: compiled.ok ? '' : tailClip(sanitizeSandboxOutput(compiled.output), TEST_RUNNER_MAX_DIAGNOSTIC_CHARS),
        },
        findings: all.slice(0, TEST_RUNNER_MAX_FINDINGS),
        findingCount: all.length,
        refusedPaths: [],
        truncated: all.length > TEST_RUNNER_MAX_FINDINGS,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return {
    tool: 'test_runner',
    input: TestRunnerInput,
    // Identity and size only — never the candidate's source.
    describe: ({ candidate }) => ({ candidateHash: contentHash(candidate), files: String(candidate.files.length) }),
    summarize: (result) => ({
      status: result.status,
      passed: String(result.passed),
      findings: String(result.findingCount),
    }),

    execute(input, signal) {
      const run = queue.then(() => measure(input, signal));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
