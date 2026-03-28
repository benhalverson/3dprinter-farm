#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { validateProjectNotes } from './shared.ts';

const eventPath = process.env.GITHUB_EVENT_PATH;

if (!eventPath) {
  throw new Error('Missing `GITHUB_EVENT_PATH`.');
}

const eventPayload = JSON.parse(await readFile(eventPath, 'utf8'));
const pullRequestBody = eventPayload.pull_request?.body ?? '';
const validation = validateProjectNotes(pullRequestBody);

if (!validation.valid) {
  process.stderr.write(`${validation.errors.join('\n')}\n`);
  process.exit(1);
}

if (validation.skipped) {
  process.stdout.write('Project notes validation skipped.\n');
} else {
  process.stdout.write('Project notes validation passed.\n');
}
