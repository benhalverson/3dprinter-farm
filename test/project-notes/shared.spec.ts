import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProjectMarkdown,
  collectLinkedIssues,
  collectTopLevelPaths,
  parseProjectNotes,
  validateProjectNotes,
} from '../../tools/project-notes/shared.ts';

const config = {
  slug: 'on-demand-3d-printer-platform',
  title: 'On-Demand 3D Printer Platform',
  description: 'API and web application for intake, quoting, queue management, and fulfillment across custom print requests.',
  status: 'active',
  startedAt: '2026-01-12',
  featured: true,
  tags: ['TypeScript', 'API', 'Angular', '3D Printing'],
  repoUrl: 'https://github.com/benhalverson/3dprinter-farm',
  overview: 'Overview text.',
  currentMilestone: 'Current milestone text.',
  roadmap: [
    { text: 'Done roadmap item', done: true },
    { text: 'Planned roadmap item', done: false },
  ],
  recentProgressLimit: 10,
};

const mergedPullRequests = [
  {
    number: 125,
    title: 'Apply rate limiting to POST /auth/signin',
    body: `## Project notes summary

Added rate limiting to the login endpoint to make brute-force attempts more expensive.

## User-visible or operational impact

Repeated sign-in attempts now hit a clearer throttle path instead of hammering auth handlers.

## Notes / lessons / caveats

Tight rate limits need environment-aware tuning so local testing stays easy and production stays defensive.
`,
    htmlUrl: 'https://github.com/benhalverson/3dprinter-farm/pull/125',
    mergedAt: '2026-03-25T12:00:00Z',
    labels: ['security', 'auth'],
    files: [{ filename: 'src/routes/auth.ts' }, { filename: 'test/routes/auth.spec.ts' }],
    parsedNotes: {
      skip: false,
      summary: 'Added rate limiting to the login endpoint to make brute-force attempts more expensive.',
      impact:
        'Repeated sign-in attempts now hit a clearer throttle path instead of hammering auth handlers.',
      notes:
        'Tight rate limits need environment-aware tuning so local testing stays easy and production stays defensive.',
    },
  },
  {
    number: 124,
    title: 'Fix hosted checkout: include userId in Stripe session metadata (#98)',
    body: `## Project notes summary

Made checkout metadata more reliable so downstream order handling can trust user ownership.

## User-visible or operational impact

Operators can trace checkout sessions back to the correct authenticated user more consistently.

## Notes / lessons / caveats

Payment integrations stay safer when identity is bound server-side instead of trusted from client input.
`,
    htmlUrl: 'https://github.com/benhalverson/3dprinter-farm/pull/124',
    mergedAt: '2026-03-24T08:30:00Z',
    labels: ['payments'],
    files: [{ filename: 'src/routes/payments.ts' }, { filename: 'README.md' }],
    parsedNotes: {
      skip: false,
      summary:
        'Made checkout metadata more reliable so downstream order handling can trust user ownership.',
      impact:
        'Operators can trace checkout sessions back to the correct authenticated user more consistently.',
      notes:
        'Payment integrations stay safer when identity is bound server-side instead of trusted from client input.',
    },
  },
];

test('parseProjectNotes extracts the required sections and unchecked skip flag', () => {
  const parsed = parseProjectNotes(`## Project notes summary

Summary text.

## User-visible or operational impact

Impact text.

## Notes / lessons / caveats

Notes text.

- [ ] Skip project notes`);

  assert.deepEqual(parsed, {
    skip: false,
    summary: 'Summary text.',
    impact: 'Impact text.',
    notes: 'Notes text.',
  });
});

test('validateProjectNotes treats checked skip as a valid bypass', () => {
  const validation = validateProjectNotes(`## Project notes summary

## User-visible or operational impact

## Notes / lessons / caveats

- [x] Skip project notes`);

  assert.equal(validation.valid, true);
  assert.equal(validation.skipped, true);
});

test('validateProjectNotes reports missing sections when notes are required', () => {
  const validation = validateProjectNotes(`## Project notes summary

Shipped a safer auth path.

## User-visible or operational impact
`);

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors, [
    'Missing or empty `## User-visible or operational impact` section.',
    'Missing or empty `## Notes / lessons / caveats` section.',
  ]);
});

test('project-notes helpers collect linked issues and top-level paths deterministically', () => {
  assert.deepEqual(collectLinkedIssues({ title: 'Fix checkout (#91)', body: 'Closes #101 and refs #77.' }), [
    '#77',
    '#91',
    '#101',
  ]);
  assert.deepEqual(
    collectTopLevelPaths([{ filename: 'src/routes/payments.ts' }, { filename: 'test/routes/payments.spec.ts' }]),
    ['src', 'test'],
  );
});

test('buildProjectMarkdown renders deterministic markdown output', () => {
  const markdown = buildProjectMarkdown(config, mergedPullRequests, {
    sourceRepository: 'benhalverson/3dprinter-farm',
    sourceBranch: 'main',
    generatedAt: '2026-03-27T00:00:00.000Z',
  });

  const expected = [
    '---',
    'title: On-Demand 3D Printer Platform',
    'slug: on-demand-3d-printer-platform',
    'description: API and web application for intake, quoting, queue management, and fulfillment across custom print requests.',
    'status: active',
    'startedAt: 2026-01-12',
    'updatedAt: 2026-03-25',
    'tags:',
    '  - TypeScript',
    '  - API',
    '  - Angular',
    '  - 3D Printing',
    'draft: false',
    'featured: true',
    'repoUrl: https://github.com/benhalverson/3dprinter-farm',
    '---',
    '',
    '## Overview',
    '',
    'Overview text.',
    '',
    '## Current milestone',
    '',
    'Current milestone text.',
    '',
    '## Roadmap',
    '',
    '- [x] Done roadmap item',
    '- [ ] Planned roadmap item',
    '',
    '## Recent progress',
    '',
    '### 2026-03-25 · [Apply rate limiting to POST /auth/signin (#125)](https://github.com/benhalverson/3dprinter-farm/pull/125)',
    '',
    'Added rate limiting to the login endpoint to make brute-force attempts more expensive.',
    '',
    'Impact: Repeated sign-in attempts now hit a clearer throttle path instead of hammering auth handlers.',
    '',
    'Context: labels `security`, `auth` | paths `src`, `test`',
    '',
    '### 2026-03-24 · [Fix hosted checkout: include userId in Stripe session metadata (#98) (#124)](https://github.com/benhalverson/3dprinter-farm/pull/124)',
    '',
    'Made checkout metadata more reliable so downstream order handling can trust user ownership.',
    '',
    'Impact: Operators can trace checkout sessions back to the correct authenticated user more consistently.',
    '',
    'Context: labels `payments` | issues #98 | paths `README.md`, `src`',
    '',
    '## Notes',
    '',
    '- 2026-03-25: Tight rate limits need environment-aware tuning so local testing stays easy and production stays defensive.',
    '- 2026-03-24: Payment integrations stay safer when identity is bound server-side instead of trusted from client input.',
    '',
    '<!-- project-notes-sync: {"sourceRepository":"benhalverson/3dprinter-farm","sourceBranch":"main","generatorVersion":"1.0.0","generatedAt":"2026-03-27T00:00:00.000Z"} -->',
    '',
  ].join('\n');

  assert.equal(markdown, expected);
  assert.match(markdown, /## Recent progress/);
  assert.match(markdown, /Context: labels `security`, `auth` \| paths `src`, `test`/);
});

test('buildProjectMarkdown is idempotent for the same input', () => {
  const first = buildProjectMarkdown(config, mergedPullRequests, {
    sourceRepository: 'benhalverson/3dprinter-farm',
    sourceBranch: 'main',
    generatedAt: '2026-03-27T00:00:00.000Z',
  });
  const second = buildProjectMarkdown(config, mergedPullRequests, {
    sourceRepository: 'benhalverson/3dprinter-farm',
    sourceBranch: 'main',
    generatedAt: '2026-03-27T00:00:00.000Z',
  });

  assert.equal(first, second);
});

test('buildProjectMarkdown deduplicates repeated rolling notes and ignores skipped PRs', () => {
  const markdown = buildProjectMarkdown(config, [
      mergedPullRequests[0],
      {
        ...mergedPullRequests[1],
        number: 126,
        mergedAt: '2026-03-26T09:00:00Z',
        parsedNotes: {
          ...mergedPullRequests[1].parsedNotes,
          notes: mergedPullRequests[0].parsedNotes.notes,
        },
      },
      {
        ...mergedPullRequests[1],
        number: 127,
        mergedAt: '2026-03-27T09:00:00Z',
        parsedNotes: {
          skip: true,
          summary: '',
          impact: '',
          notes: '',
        },
      },
    ], {
    sourceRepository: 'benhalverson/3dprinter-farm',
    sourceBranch: 'main',
    generatedAt: '2026-03-27T00:00:00.000Z',
  });

  assert.equal(markdown.match(/Tight rate limits need environment-aware tuning/g)?.length, 1);
  assert.equal(markdown.includes('(#127)'), false);
});
