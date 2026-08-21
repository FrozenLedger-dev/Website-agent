/**
 * There is one policy implementation, and the orchestrator is not it.
 *
 * The extraction moved the deterministic rules into `@statxai/policy-engine`.
 * The failure mode it guards against is not a bad move — it is a *partial* one:
 * a copy left behind that still compiles, still passes its own tests, and
 * quietly disagrees with the real thing months later. So rather than trusting
 * that the delete happened, these read the orchestrator's own source back.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as policy from '@statxai/policy-engine';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sources = async (): Promise<{ file: string; code: string }[]> => {
  const names = (await readdir(SRC)).filter((n) => n.endsWith('.ts'));
  return Promise.all(
    names.map(async (file) => ({ file, code: await readFile(join(SRC, file), 'utf8') })),
  );
};

/** Every value the policy engine exports, by name. */
const EXPORTED = Object.keys(policy).sort();

describe('one authoritative policy implementation', () => {
  it('exports the decisions the orchestrator used to make itself', () => {
    // A guard on the guard: if these names disappear, the checks below would
    // pass by scanning for nothing.
    for (const name of [
      'permittedStrategies',
      'authorizeRoute',
      'legalAdjudicationActions',
      'authorizeAdjudication',
      'fallbackAction',
      'firstBlockerId',
      'scopeViolations',
      'isEmptyDelta',
      'authorizeReplanRevision',
      'authorizeRelease',
      'verifyAcknowledged',
      'terminalForRefusal',
      'isReleaseBlocked',
      'legalTerminalOutcomes',
    ]) {
      expect(EXPORTED, `${name} should be part of the policy surface`).toContain(name);
    }
  });

  it('redefines none of them', async () => {
    // `function foo(` or `const foo =` at the top level of an orchestrator
    // module would be a second copy, whichever one the imports happened to win.
    for (const { file, code } of await sources()) {
      for (const name of EXPORTED) {
        const declared = new RegExp(`^(export )?(async )?(function|const|class) ${name}\\b`, 'm');
        expect(declared.test(code), `${file} redeclares ${name}`).toBe(false);
      }
    }
  });

  it('reaches policy only through the package, never through a relative path', async () => {
    // A deep import would bypass the package's public surface and make the
    // boundary unenforceable from the outside.
    for (const { file, code } of await sources()) {
      expect(code, file).not.toMatch(/from '\.\.\/\.\.\/policy-engine/);
      expect(code, file).not.toMatch(/@statxai\/policy-engine\/(src|dist)/);
    }
  });
});

describe('what the policy engine is not allowed to touch', () => {
  /**
   * The package decides; it does not act. If it ever grew a database handle, a
   * model call or an environment read, a "pure decision" would start having
   * side effects that no caller could see coming — and the whole reason the
   * harness can be trusted over the models is that its half is inspectable.
   */
  const POLICY_SRC = join(SRC, '..', '..', 'policy-engine', 'src');

  const policySources = async () => {
    const names = (await readdir(POLICY_SRC)).filter((n) => n.endsWith('.ts'));
    return Promise.all(
      names.map(async (file) => ({ file, code: await readFile(join(POLICY_SRC, file), 'utf8') })),
    );
  };

  it('imports nothing but the contracts', async () => {
    for (const { file, code } of await policySources()) {
      const imports = [...code.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1]!);
      for (const specifier of imports) {
        const local = specifier.startsWith('.');
        expect(local || specifier === '@statxai/contracts', `${file} imports ${specifier}`).toBe(
          true,
        );
      }
    }
  });

  it('reads no environment, filesystem, database, network or clock', async () => {
    const forbidden: [RegExp, string][] = [
      [/process\.env/, 'environment'],
      [/node:fs|readFile|writeFile/, 'filesystem'],
      [/mongodb|MongoClient|collection\(/, 'database'],
      [/\bfetch\(|node:http/, 'network'],
      [/Date\.now\(|new Date\(/, 'clock'],
      [/ModelClient|openai/i, 'model'],
    ];
    for (const { file, code } of await policySources()) {
      for (const [pattern, what] of forbidden) {
        expect(pattern.test(code), `${file} touches the ${what}`).toBe(false);
      }
    }
  });
});
