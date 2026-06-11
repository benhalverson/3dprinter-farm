import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

export const GENERATOR_VERSION = '1.0.0';
export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'project-notes.config.json');
export const DEFAULT_RECENT_PROGRESS_LIMIT = 10;
export const DEFAULT_RECENT_NOTES_LIMIT = 6;
export const PROJECT_NOTES_HEADINGS = [
  'project notes summary',
  'user-visible or operational impact',
  'notes / lessons / caveats',
];

const projectStatusSchema = z.enum(['active', 'paused', 'planning', 'shipping']);

const projectConfigSchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  status: projectStatusSchema,
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  featured: z.boolean(),
  tags: z.array(z.string().trim().min(1)).min(1),
  repoUrl: z.string().trim().url().optional(),
  overview: z.string().trim().min(1),
  currentMilestone: z.string().trim().min(1),
  roadmap: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        done: z.boolean(),
      }),
    )
    .min(1),
  recentProgressLimit: z.number().int().positive().max(50).optional(),
});

type ProjectConfig = z.infer<typeof projectConfigSchema>;

type ParsedProjectNotes = {
  skip: boolean;
  summary: string;
  impact: string;
  notes: string;
};

type GitHubPullFile = {
  filename: string;
};

type PullRequestNotesInput = {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  mergedAt: string;
  labels: string[];
  files: GitHubPullFile[];
  parsedNotes: ParsedProjectNotes;
};

export async function loadProjectConfig(configPath = DEFAULT_CONFIG_PATH): Promise<ProjectConfig> {
  const rawConfig = await readFile(configPath, 'utf8');
  const parsedConfig = JSON.parse(rawConfig);

  return projectConfigSchema.parse({
    ...parsedConfig,
    recentProgressLimit: parsedConfig.recentProgressLimit ?? DEFAULT_RECENT_PROGRESS_LIMIT,
  });
}

export function parseProjectNotes(body = ''): ParsedProjectNotes {
  const sanitizedBody = stripHtmlComments(body).replace(/\r\n/g, '\n');
  const skip = /^\s*-\s*\[(x|X)\]\s+Skip project notes\s*$/m.test(sanitizedBody);
  const sections: Record<string, string> = {};

  for (const heading of PROJECT_NOTES_HEADINGS) {
    sections[heading] = extractMarkdownSection(sanitizedBody, heading);
  }

  return {
    skip,
    summary: sections['project notes summary'],
    impact: sections['user-visible or operational impact'],
    notes: sections['notes / lessons / caveats'].replace(/^\s*-\s*\[(?: |x|X)\]\s+Skip project notes\s*$/gm, '').trim(),
  };
}

export function validateProjectNotes(body = '') {
  const parsed = parseProjectNotes(body);

  if (parsed.skip) {
    return {
      valid: true,
      skipped: true,
      errors: [],
      parsed,
    };
  }

  const errors = [];

  if (!parsed.summary) {
    errors.push('Missing or empty `## Project notes summary` section.');
  }

  if (!parsed.impact) {
    errors.push('Missing or empty `## User-visible or operational impact` section.');
  }

  if (!parsed.notes) {
    errors.push('Missing or empty `## Notes / lessons / caveats` section.');
  }

  return {
    valid: errors.length === 0,
    skipped: false,
    errors,
    parsed,
  };
}

export function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function collectLinkedIssues({ title = '', body = '' }) {
  const matches = `${title}\n${body}`.match(/(^|[\s(])#(\d+)\b/gm) ?? [];
  const issueNumbers = new Set();

  for (const match of matches) {
    const numberMatch = match.match(/#(\d+)\b/);

    if (numberMatch) {
      issueNumbers.add(`#${numberMatch[1]}`);
    }
  }

  return [...issueNumbers].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export function collectTopLevelPaths(files: GitHubPullFile[] = []) {
  const topLevelPaths = new Set<string>();

  for (const file of files) {
    if (!file?.filename) {
      continue;
    }

    const normalizedPath = file.filename.replace(/^\/+/, '');
    const [topLevel] = normalizedPath.split('/');
    topLevelPaths.add(topLevel || normalizedPath);
  }

  return [...topLevelPaths].sort();
}

export function buildProjectMarkdown(
  projectConfig: ProjectConfig,
  pullRequests: PullRequestNotesInput[],
  options: {
    generatedAt?: string;
    sourceRepository?: string;
    sourceBranch?: string;
    recentNotesLimit?: number;
  } = {},
) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceRepository = options.sourceRepository ?? deriveRepositorySlug();
  const sourceBranch = options.sourceBranch ?? 'main';
  const recentNotesLimit = options.recentNotesLimit ?? DEFAULT_RECENT_NOTES_LIMIT;
  const includedPullRequests = [...pullRequests]
    .map(normalizePullRequestNotes)
    .filter((pullRequest) => !pullRequest.parsedNotes.skip && pullRequest.parsedNotes.summary && pullRequest.parsedNotes.impact)
    .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt))
    .slice(0, projectConfig.recentProgressLimit);
  const updatedAt = includedPullRequests[0]?.mergedAt.slice(0, 10) ?? projectConfig.startedAt;
  const recentNotes = collectRecentNotes(includedPullRequests, recentNotesLimit);
  const frontmatterLines = [
    '---',
    `title: ${projectConfig.title}`,
    `slug: ${projectConfig.slug}`,
    `description: ${projectConfig.description}`,
    `status: ${projectConfig.status}`,
    `startedAt: ${projectConfig.startedAt}`,
    `updatedAt: ${updatedAt}`,
    'tags:',
    ...projectConfig.tags.map((tag) => `  - ${tag}`),
    'draft: false',
    `featured: ${projectConfig.featured ? 'true' : 'false'}`,
    ...(projectConfig.repoUrl ? [`repoUrl: ${projectConfig.repoUrl}`] : []),
    '---',
  ];

  const roadmapLines = projectConfig.roadmap.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`);
  const progressSection =
    includedPullRequests.length > 0
      ? includedPullRequests.map((pullRequest) => renderProgressEntry(pullRequest)).join('\n\n')
      : 'No merged pull requests with project notes have been captured yet.';
  const notesSection =
    recentNotes.length > 0
      ? recentNotes.map((note) => `- ${note.mergedDate}: ${note.text}`).join('\n')
      : '- No rolling notes have been captured yet.';
  const syncMarker = `<!-- project-notes-sync: ${JSON.stringify({
    sourceRepository,
    sourceBranch,
    generatorVersion: GENERATOR_VERSION,
    generatedAt,
  })} -->`;

  return [
    ...frontmatterLines,
    '',
    '## Overview',
    '',
    projectConfig.overview.trim(),
    '',
    '## Current milestone',
    '',
    projectConfig.currentMilestone.trim(),
    '',
    '## Roadmap',
    '',
    ...roadmapLines,
    '',
    '## Recent progress',
    '',
    progressSection,
    '',
    '## Notes',
    '',
    notesSection,
    '',
    syncMarker,
    '',
  ].join('\n');
}

export async function writeProjectMarkdown(outputPath, markdown) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');
}

export async function fetchMergedPullRequests({
  owner,
  repo,
  token,
  baseBranch = 'main',
  maxPages = 5,
  perPage = 100,
  progressLimit = DEFAULT_RECENT_PROGRESS_LIMIT,
}: {
  owner: string;
  repo: string;
  token: string;
  baseBranch?: string;
  maxPages?: number;
  perPage?: number;
  progressLimit?: number;
}) {
  const mergedPullRequests: Array<{
    number: number;
    title: string;
    body: string;
    htmlUrl: string;
    mergedAt: string;
    labels: string[];
  }> = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const pulls = await githubRequest(
      `/repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(baseBranch)}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      token,
    );

    if (!Array.isArray(pulls) || pulls.length === 0) {
      break;
    }

    for (const pull of pulls) {
      if (!pull.merged_at) {
        continue;
      }

      mergedPullRequests.push({
        number: pull.number,
        title: pull.title,
        body: pull.body ?? '',
        htmlUrl: pull.html_url,
        mergedAt: pull.merged_at,
        labels: Array.isArray(pull.labels) ? pull.labels.map((label) => label.name).filter(Boolean) : [],
      });
    }

    if (pulls.length < perPage) {
      break;
    }
  }

  const sortedPullRequests = mergedPullRequests.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  const selectedPullRequests = sortedPullRequests.slice(0, Math.max(progressLimit * 3, 30));

  return Promise.all(
    selectedPullRequests.map(async (pullRequest) => {
      const files = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/files?per_page=100`, token);

      return normalizePullRequestNotes({
        ...pullRequest,
        files: Array.isArray(files) ? files : [],
        parsedNotes: parseProjectNotes(pullRequest.body),
      });
    }),
  );
}

export function deriveRepositorySlug() {
  const repository = process.env.GITHUB_REPOSITORY;

  if (repository) {
    return repository;
  }

  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sshMatch = remoteUrl.match(/github\.com:(.+?)\/(.+?)(?:\.git)?$/);
    const httpsMatch = remoteUrl.match(/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);
    const match = sshMatch ?? httpsMatch;

    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {}

  return 'unknown/unknown';
}

export function splitRepositorySlug(repositorySlug) {
  const [owner, repo] = repositorySlug.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repository slug: ${repositorySlug}`);
  }

  return { owner, repo };
}

function extractMarkdownSection(body, heading) {
  const escapedHeading = escapeRegExp(heading);
  const sectionPattern = new RegExp(`(^|\\n)##\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const match = body.match(sectionPattern);

  if (!match) {
    return '';
  }

  return stripMarkdownComments(match[2]);
}

function stripMarkdownComments(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function stripHtmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function collectRecentNotes(pullRequests, limit) {
  const notes = [];
  const seenNotes = new Set();

  for (const pullRequest of pullRequests) {
    const noteText = normalizeWhitespace(pullRequest.parsedNotes.notes ?? '');

    if (!noteText) {
      continue;
    }

    const dedupeKey = noteText.toLowerCase();

    if (seenNotes.has(dedupeKey)) {
      continue;
    }

    seenNotes.add(dedupeKey);
    notes.push({
      mergedDate: pullRequest.mergedAt.slice(0, 10),
      text: noteText,
    });

    if (notes.length >= limit) {
      break;
    }
  }

  return notes;
}

function normalizePullRequestNotes(pullRequest) {
  const parsedNotes = pullRequest.parsedNotes ?? parseProjectNotes(pullRequest.body ?? '');
  const fallbackParagraphs = extractFallbackParagraphs(pullRequest.body ?? '');

  return {
    ...pullRequest,
    parsedNotes: {
      ...parsedNotes,
      summary: parsedNotes.summary || fallbackParagraphs[0] || pullRequest.title,
      impact: parsedNotes.impact || fallbackParagraphs[1] || 'See the linked pull request for implementation details.',
      notes: parsedNotes.notes || '',
    },
  };
}

function renderProgressEntry(pullRequest) {
  const mergedDate = pullRequest.mergedAt.slice(0, 10);
  const issueReferences = collectLinkedIssues({ title: pullRequest.title, body: pullRequest.body });
  const topLevelPaths = collectTopLevelPaths(pullRequest.files);
  const contextParts = [];

  if (pullRequest.labels.length > 0) {
    contextParts.push(`labels ${pullRequest.labels.map((label) => `\`${label}\``).join(', ')}`);
  }

  if (issueReferences.length > 0) {
    contextParts.push(`issues ${issueReferences.join(', ')}`);
  }

  if (topLevelPaths.length > 0) {
    contextParts.push(`paths ${topLevelPaths.map((segment) => `\`${segment}\``).join(', ')}`);
  }

  const lines = [
    `### ${mergedDate} · [${escapeMarkdown(pullRequest.title)} (#${pullRequest.number})](${pullRequest.htmlUrl})`,
    '',
    pullRequest.parsedNotes.summary.trim(),
    '',
    `Impact: ${pullRequest.parsedNotes.impact.trim()}`,
  ];

  if (contextParts.length > 0) {
    lines.push('', `Context: ${contextParts.join(' | ')}`);
  }

  return lines.join('\n');
}

function extractFallbackParagraphs(body) {
  return stripMarkdownComments(body)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#'));
}

async function githubRequest(route, token) {
  if (!token) {
    throw new Error('Missing GitHub token. Set `GITHUB_TOKEN` or pass `--token`.');
  }

  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'project-notes-generator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`GitHub API request failed for ${route}: ${response.status} ${response.statusText}\n${responseBody}`);
  }

  return response.json();
}

function escapeMarkdown(value) {
  return value.replace(/([\[\]])/g, '\\$1');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
