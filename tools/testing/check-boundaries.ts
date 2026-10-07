import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Keep emulator startup out of every test entry point, including integration tests.
const files = ['vitest.config.mts', 'vitest.database.config.mts'];
function collect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.[cm]?tsx?$/.test(path)) files.push(path);
  }
}
collect('test');
const forbidden =
  /miniflare|@cloudflare\/vitest-pool-workers|cloudflare:test|admin-demo\/runtime|\bwrangler\b/i;
const failures = files.filter(path =>
  forbidden.test(readFileSync(path, 'utf8')),
);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of ['miniflare', '@cloudflare/vitest-pool-workers']) {
  if (pkg.dependencies?.[name] || pkg.devDependencies?.[name])
    failures.push(`package.json: ${name}`);
}
if (failures.length)
  throw new Error(`Forbidden test runtime references: ${failures.join(', ')}`);
console.log(
  `Test boundaries verified (${files.length} files): no Worker emulator or Wrangler test entry points.`,
);
