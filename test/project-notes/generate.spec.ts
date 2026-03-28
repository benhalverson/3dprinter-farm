import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProjectConfig } from '../../tools/project-notes/shared.ts';

const tempDirectories = [];
const execFileAsync = promisify(execFile);

test.afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('generate-project-notes writes the markdown file from a fixture pulls file', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'project-notes-'));
  tempDirectories.push(tempDirectory);

  const fixturePath = path.join(tempDirectory, 'pulls.json');
  const outputPath = path.join(tempDirectory, 'generated.md');
  await writeFile(
    fixturePath,
    JSON.stringify([
      {
        number: 120,
        title: 'Enforce cart ownership across all cart mutation routes',
        body: `## Project notes summary

Bound cart mutation routes to the authenticated cart owner instead of trusting caller input.

## User-visible or operational impact

Cross-user cart mutations now fail instead of silently applying to the wrong account.

## Notes / lessons / caveats

Ownership checks need to be centralized or they drift when endpoint count grows.
`,
        htmlUrl: 'https://github.com/benhalverson/3dprinter-farm/pull/120',
        mergedAt: '2026-03-24T12:34:56.000Z',
        labels: ['security'],
        files: [{ filename: 'src/routes/shoppingCart.ts' }],
        parsedNotes: {
          skip: false,
          summary:
            'Bound cart mutation routes to the authenticated cart owner instead of trusting caller input.',
          impact:
            'Cross-user cart mutations now fail instead of silently applying to the wrong account.',
          notes: 'Ownership checks need to be centralized or they drift when endpoint count grows.',
        },
      },
    ]),
    'utf8',
  );

  await execFileAsync(
    'node',
    [
      '--disable-warning=ExperimentalWarning',
      '--experimental-default-type=module',
      '--experimental-strip-types',
      'tools/project-notes/generate-project-notes.ts',
      '--config',
      'project-notes.config.json',
      '--pullsFile',
      fixturePath,
      '--output',
      outputPath,
      '--repository',
      'benhalverson/3dprinter-farm',
      '--branch',
      'main',
    ],
    {
      cwd: '/home/ben/projects/3dprinter-web-api',
      env: {
        ...process.env,
        GENERATED_AT: '2026-03-27T00:00:00.000Z',
      },
    },
  );

  const contents = await readFile(outputPath, 'utf8');
  const config = await loadProjectConfig('/home/ben/projects/3dprinter-web-api/project-notes.config.json');

  assert.match(contents, new RegExp(`title: ${config.title}`));
  assert.match(contents, /### 2026-03-24 · \[Enforce cart ownership across all cart mutation routes \(#120\)\]/);
  assert.match(contents, /Context: labels `security` \| paths `src`/);
});
