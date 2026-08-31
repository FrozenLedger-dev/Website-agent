/**
 * Reading the brief, and standing the project up.
 *
 * The property worth pinning hardest is negative: a brief the platform will not
 * accept must leave everything exactly as it was. Startup deletes the project
 * record, its budget and its per-defect counters, so validating *after* that
 * would mean a malformed retry destroyed the previous run's work — and the
 * failure would be silent, because the caller sees `intake_insufficient`
 * either way.
 *
 * The other distinction under test is what counts as a refusal at all. An
 * unusable brief is a client information problem and comes back as a result. A
 * workspace that will not open is a platform failure and throws. Reporting the
 * second as the first would tell a customer their form was incomplete when the
 * deployment was broken.
 *
 * Collaborators are fakes, which the extraction is what made possible: the
 * phase takes them as arguments. The Mongo-backed suites still prove the real
 * persistence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as State from '@statxai/state';
import type * as Workspace from '@statxai/workspace';
import type { StateStore } from '@statxai/state';
import type { ArtifactRegistry } from '@statxai/workspace';

/** Every side effect, in the order it happened. */
const calls: string[] = [];
let workspaceOpenFails: Error | null = null;
let registryPutFails: Error | null = null;
let budgetMissing = false;

const materialised: { path: string; data: unknown }[] = [];
const putArtifacts: { name: string; data: unknown }[] = [];

vi.mock('@statxai/state', async (importOriginal) => {
  const actual = await importOriginal<typeof State>();
  return {
    ...actual,
    createBudget: vi.fn(async () => {
      calls.push('createBudget');
    }),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    ProjectWorkspace: {
      open: vi.fn(async () => {
        calls.push('workspace.open');
        if (workspaceOpenFails) throw workspaceOpenFails;
        return {
          materialiseArtifact: async (path: string, data: unknown) => {
            calls.push(`materialise:${path}`);
            materialised.push({ path, data });
          },
        };
      }),
    },
  };
});

const INTAKE = {
  businessName: 'Harrowgate Joinery',
  industry: 'Joinery',
  location: 'Harrogate',
  audience: 'Homeowners',
  services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }],
  differentiators: ['Two joiners'],
  contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' },
  tone: 'Warm',
  goals: ['Enquiries'],
};

const store = () =>
  ({
    projects: {
      deleteOne: async () => void calls.push('projects.deleteOne'),
      insertOne: async (doc: Record<string, unknown>) => {
        calls.push(`projects.insertOne:${String(doc['state'])}`);
      },
    },
    budgets: {
      deleteOne: async () => void calls.push('budgets.deleteOne'),
      findOne: async () => {
        calls.push('budgets.findOne');
        return budgetMissing ? null : { limits: { totalRepairJobs: 8, replans: 2 } };
      },
    },
    defectBudgets: { deleteMany: async () => void calls.push('defectBudgets.deleteMany') },
    // Present so a mutation that clears artifact history is observable rather
    // than silently absent from the fake.
    artifacts: { deleteMany: async () => void calls.push('artifacts.deleteMany') },
    artifactSequences: { deleteOne: async () => void calls.push('artifactSequences.deleteOne') },
  }) as unknown as StateStore;

const registry = () =>
  ({
    put: async (_projectId: string, name: string, data: unknown) => {
      calls.push(`registry.put:${name}`);
      if (registryPutFails) throw registryPutFails;
      putArtifacts.push({ name, data });
      return { name, version: 1, contentHash: 'hash' };
    },
    accept: async (_projectId: string, ref: { name: string }) => {
      calls.push(`registry.accept:${ref.name}`);
    },
  }) as unknown as ArtifactRegistry;

const events: { phase: string; detail: string; level?: string }[] = [];

const discover = async (intake: unknown) => {
  const { discoverProject } = await import('../src/phases/discover.js');
  return discoverProject({
    projectId: 'proj_discover',
    intake,
    store: store(),
    registry: registry(),
    workspacesRoot: '/tmp/does-not-matter',
    autonomyMode: 'full_autonomous',
    say: (e) => void events.push(e),
  });
};

beforeEach(() => {
  calls.length = 0;
  events.length = 0;
  materialised.length = 0;
  putArtifacts.length = 0;
  workspaceOpenFails = null;
  registryPutFails = null;
  budgetMissing = false;
});

describe('a brief that does not parse', () => {
  it('is refused, and says which field', async () => {
    const result = await discover({ businessName: 'Harrowgate Joinery' });

    expect(result).toEqual({ ok: false, outcome: 'intake_insufficient' });
    expect(events[0]?.detail).toBe('Validating intake against the canonical schema');
    expect(events.at(-1)?.level).toBe('fail');
    expect(events.at(-1)?.detail).toMatch(/^Intake rejected: /);
  });

  it('changes nothing at all', async () => {
    // The whole point. An existing project keeps its state, its budget and its
    // repair history, because none of them were touched.
    await discover({ nonsense: true });
    expect(calls).toEqual([]);
  });
});

describe('a brief that parses but says too little', () => {
  it('is refused for the reasons it is missing', async () => {
    // `differentiators` has no minimum and `email` is only a non-empty string,
    // so both of these clear the schema and are caught by the sufficiency
    // check instead — which is exactly why that check exists.
    const result = await discover({
      ...INTAKE,
      differentiators: [],
      contact: { ...INTAKE.contact, email: 'call the workshop' },
    });

    expect(result).toEqual({ ok: false, outcome: 'intake_insufficient' });
    expect(events.at(-1)?.detail).toBe(
      'Intake insufficient: no differentiators listed; contact email is not an address',
    );
    expect(events.at(-1)?.level).toBe('fail');
  });

  it('changes nothing either', async () => {
    // Passing the schema is not permission to start the project. This is the
    // branch a "we already validated, so reset first" refactor would break.
    await discover({ ...INTAKE, differentiators: [] });
    expect(calls).toEqual([]);
  });
});

describe('a brief the platform accepts', () => {
  it('returns the canonical profile, the workspace and the ceilings', async () => {
    const result = await discover(INTAKE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.businessName).toBe('Harrowgate Joinery');
    expect(result.workspace).toBeDefined();
    expect(result.budgetLimits).toEqual({ totalRepairJobs: 8, replans: 2 });

    expect(events.at(-1)).toEqual({
      phase: 'discover',
      detail: 'Harrowgate Joinery — 1 services',
      level: 'ok',
    });
  });

  it('does the setup in the one order that is safe', async () => {
    // Validation before anything destructive; the lifecycle record and its
    // budgets reset together; the profile recorded, accepted, then written to
    // the workspace; the ceilings read last, after the budget exists.
    await discover(INTAKE);

    expect(calls).toEqual([
      'workspace.open',
      'projects.deleteOne',
      'budgets.deleteOne',
      'defectBudgets.deleteMany',
      'projects.insertOne:planning',
      'createBudget',
      'registry.put:business-profile',
      'registry.accept:business-profile',
      'materialise:client/business-profile.json',
      'budgets.findOne',
    ]);
  });

  it('never clears the artifact history or its counter', async () => {
    // Artifacts outlive the project record on purpose: a second run for the
    // same project continues the lineage rather than restarting it.
    await discover(INTAKE);

    expect(calls).not.toContain('artifacts.deleteMany');
    expect(calls).not.toContain('artifactSequences.deleteOne');
  });

  it('records the parsed profile, not what the caller sent', async () => {
    // The artifact and the file are what everything downstream measures
    // against — the planner, the claims gate, the reviewer. Handing on the raw
    // intake would let unvalidated extra fields through as canonical fact.
    await discover({ ...INTAKE, sneakyExtra: 'not in the schema' });

    expect(putArtifacts).toHaveLength(1);
    expect(putArtifacts[0]?.name).toBe('business-profile');
    expect(putArtifacts[0]?.data).not.toHaveProperty('sneakyExtra');
    expect(materialised).toEqual([
      { path: 'client/business-profile.json', data: putArtifacts[0]?.data },
    ]);
  });
});

describe('when the platform itself fails', () => {
  it('does not dress a broken workspace up as a bad brief', async () => {
    workspaceOpenFails = new Error('permission denied on the workspaces root');
    await expect(discover(INTAKE)).rejects.toThrow(/permission denied/);
  });

  it('does not dress a broken registry up as a bad brief', async () => {
    registryPutFails = new Error('replica set unreachable');
    await expect(discover(INTAKE)).rejects.toThrow(/replica set unreachable/);
  });

  it('refuses to invent budget ceilings for a budget it just created', async () => {
    // Defaulting here would let a run spend against limits nobody set.
    budgetMissing = true;
    await expect(discover(INTAKE)).rejects.toThrow(/missing immediately after creation/);
  });
});
