#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_CONFIG_PATH,
  buildProjectMarkdown,
  deriveRepositorySlug,
  fetchMergedPullRequests,
  loadProjectConfig,
  splitRepositorySlug,
  writeProjectMarkdown,
} from './shared.ts';

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(process.cwd(), args.config ?? DEFAULT_CONFIG_PATH);
const outputPath = path.resolve(process.cwd(), args.output ?? path.join('.generated', 'project-notes', 'project.md'));
const sourceRepository = args.repository ?? deriveRepositorySlug();
const sourceBranch = args.branch ?? process.env.SOURCE_BRANCH ?? 'main';
const githubToken = args.token ?? process.env.GITHUB_TOKEN ?? '';
const projectConfig = await loadProjectConfig(configPath);
const repositorySlug = splitRepositorySlug(sourceRepository);

let pullRequests;

if (args.pullsFile) {
  const pullsFile = await readFile(path.resolve(process.cwd(), args.pullsFile), 'utf8');
  pullRequests = JSON.parse(pullsFile);
} else {
  pullRequests = await fetchMergedPullRequests({
    ...repositorySlug,
    token: githubToken,
    baseBranch: sourceBranch,
    progressLimit: projectConfig.recentProgressLimit,
  });
}

const markdown = buildProjectMarkdown(projectConfig, pullRequests, {
  sourceRepository,
  sourceBranch,
  generatedAt: process.env.GENERATED_AT ?? new Date().toISOString(),
});

await writeProjectMarkdown(outputPath, markdown);
process.stdout.write(`${outputPath}\n`);

function parseArgs(values) {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const nextValue = values[index + 1];

    if (!nextValue || nextValue.startsWith('--')) {
      parsed[key] = 'true';
      continue;
    }

    parsed[key] = nextValue;
    index += 1;
  }

  return parsed;
}
