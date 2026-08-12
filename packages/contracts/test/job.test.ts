import { describe, expect, it } from 'vitest';
import {
  JobSpec,
  assertTransition,
  canTransition,
  formatArtifactUri,
  outputsConflict,
  parseArtifactUri,
} from '../src/index.js';

describe('job state machine', () => {
  it('permits the documented happy path draft → ready → running → validating → accepted', () => {
    expect(canTransition('draft', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'validating')).toBe(true);
    expect(canTransition('validating', 'accepted')).toBe(true);
  });

  it('treats accepted as terminal', () => {
    for (const to of ['ready', 'running', 'failed', 'blocked'] as const) {
      expect(canTransition('accepted', to)).toBe(false);
    }
  });

  it('forbids skipping validation', () => {
    expect(canTransition('running', 'accepted')).toBe(false);
    expect(() => assertTransition('running', 'accepted')).toThrow(/Illegal job transition/);
  });

  it('allows running → ready so an expired lease can be reclaimed', () => {
    // Without this edge a crashed worker strands its job in `running` forever.
    expect(canTransition('running', 'ready')).toBe(true);
  });

  it('routes failures to repair or blocked, not straight to accepted', () => {
    expect(canTransition('validating', 'repair_requested')).toBe(true);
    expect(canTransition('failed', 'repair_requested')).toBe(true);
    expect(canTransition('failed', 'accepted')).toBe(false);
  });
});

describe('job spec', () => {
  const valid = {
    projectId: 'proj_123',
    jobId: 'job_homepage_hero',
    role: 'frontend_backend',
    objective: 'Build the homepage hero section from the accepted page specification',
    inputs: {
      businessProfile: { name: 'business-profile', version: 1 },
      pageSpec: { name: 'pages/homepage', version: 2 },
    },
    acceptanceCriteria: ['Responsive at configured breakpoints', 'Primary CTA visible above the fold'],
    allowedTools: ['filesystem', 'component_library', 'browser_preview'],
    output: ['src/components/Hero.tsx'],
  };

  it('accepts the §4 example shape', () => {
    expect(JobSpec.safeParse(valid).success).toBe(true);
  });

  it('rejects a job with no acceptance criteria', () => {
    // §7 requires every rejection to cite a criterion, so a job without any is
    // unreviewable by construction.
    const result = JobSpec.safeParse({ ...valid, acceptanceCriteria: [] });
    expect(result.success).toBe(false);
  });

  it('rejects malformed identifiers', () => {
    expect(JobSpec.safeParse({ ...valid, projectId: '123' }).success).toBe(false);
    expect(JobSpec.safeParse({ ...valid, jobId: 'homepage' }).success).toBe(false);
  });

  it('requires artifact inputs to be version-pinned', () => {
    const unpinned = { ...valid, inputs: { businessProfile: { name: 'business-profile' } } };
    expect(JobSpec.safeParse(unpinned).success).toBe(false);
  });
});

describe('artifact references', () => {
  it('round-trips through the uri form', () => {
    const uri = formatArtifactUri({ name: 'business-profile', version: 3 });
    expect(uri).toBe('artifact://business-profile@3');
    expect(parseArtifactUri(uri)).toEqual({ name: 'business-profile', version: 3 });
  });

  it('refuses an unpinned uri', () => {
    expect(() => parseArtifactUri('artifact://business-profile.json')).toThrow(/Malformed artifact URI/);
  });
});

describe('output conflict detection', () => {
  it('detects jobs that would write the same file', () => {
    expect(
      outputsConflict({ output: ['src/components/Hero.tsx'] }, { output: ['src/components/Hero.tsx', 'src/app/page.tsx'] }),
    ).toBe(true);
  });

  it('allows disjoint jobs to run in parallel', () => {
    expect(outputsConflict({ output: ['src/app/about/page.tsx'] }, { output: ['src/app/contact/page.tsx'] })).toBe(false);
  });
});
