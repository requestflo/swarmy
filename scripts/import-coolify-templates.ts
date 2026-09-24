#!/usr/bin/env bun
/**
 * Seed swarmy one-click templates from Coolify's service templates.
 *
 *   git clone --depth 1 https://github.com/coollabsio/coolify /tmp/coolify
 *   bun run scripts/import-coolify-templates.ts --src /tmp/coolify/templates/compose \
 *     [--out /tmp/swarmy-coolify-import] [--only umami,plausible]
 *
 * Coolify's templates are Apache-2.0 (© Coolify contributors). Converted
 * templates keep `source: { kind: 'coolify', path }`, which the gallery shows
 * as an attribution line, and packages/templates/NOTICE carries the licence
 * notice. Keep both when committing anything seeded from here.
 *
 * Writes, under --out:
 *   REPORT.md                 counts plus one line per template: clean / review / rejected, and why
 *   report.json               the same, machine-readable
 *   <status>/<slug>.ts        TypeScript template source for clean + review conversions
 *
 * This is a SEEDING tool and never writes into packages/templates/src/catalog.
 * Before a template joins the catalogue, a person pins the tag, sizes the memory,
 * checks the healthcheck tools and writes the first-login steps, and then it
 * passes both catalogue test suites.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  convertCoolifyTemplate,
  templateSource,
  type ImportResult,
} from '../packages/templates/src/import/coolify';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const src = arg('src');
if (!src) {
  console.error('usage: import-coolify-templates.ts --src <coolify>/templates/compose [--out dir] [--only a,b]');
  process.exit(2);
}
const out = arg('out') ?? join(tmpdir(), 'swarmy-coolify-import');
const only = arg('only')?.split(',').map((s) => s.trim());

const files = readdirSync(src)
  .filter((f) => /\.ya?ml$/.test(f))
  .filter((f) => !only || only.includes(basename(f).replace(/\.ya?ml$/, '')))
  .sort();

const results: ImportResult[] = [];
for (const f of files) {
  const slug = basename(f).replace(/\.ya?ml$/, '');
  try {
    results.push(convertCoolifyTemplate(slug, readFileSync(join(src, f), 'utf8')));
  } catch (e) {
    results.push({ slug, status: 'rejected', reasons: [`converter crashed: ${String(e)}`], info: [] });
  }
}

for (const dir of ['clean', 'review']) mkdirSync(join(out, dir), { recursive: true });
for (const r of results) {
  if (r.template && r.status !== 'rejected') {
    writeFileSync(
      join(out, r.status, `${r.slug}.ts`),
      `// Seeded from Coolify templates/compose/${r.slug}.yaml (Apache-2.0, © Coolify contributors).\n` +
        `// Review before committing: ${r.reasons.join('; ') || 'nothing flagged'}\n` +
        `import type { AppTemplate } from '../types';\n\nexport const template: AppTemplate = ${templateSource(r.template)};\n`,
    );
  }
}

const count = (s: string): number => results.filter((r) => r.status === s).length;
// Tally rejection reasons by their shape (strip the service prefix).
const why = new Map<string, number>();
for (const r of results.filter((x) => x.status === 'rejected')) {
  const k = (r.reasons[0] ?? 'unknown').replace(/^[a-z0-9-]+(\.[A-Za-z0-9_]+)?: /, '').replace(/SERVICE_[A-Z0-9_]+/g, 'SERVICE_*').slice(0, 80);
  why.set(k, (why.get(k) ?? 0) + 1);
}
const md = [
  '# Coolify → swarmy template import',
  '',
  `Source: \`${src}\` · ${results.length} templates · **${count('clean')} clean**, **${count('review')} need review**, **${count('rejected')} rejected**.`,
  '',
  'Coolify service templates are Apache-2.0 (© Coolify contributors); keep the `source` attribution on anything committed.',
  '',
  '## Top rejection reasons',
  '',
  ...[...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `- ${n} × ${k}`),
  '',
  '## Per template',
  '',
  '| template | status | category | notes |',
  '|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.slug} | ${r.status} | ${r.template?.category ?? ''} | ${r.reasons.join('; ').replace(/\|/g, '\\|')} |`,
  ),
  '',
].join('\n');
writeFileSync(join(out, 'REPORT.md'), md);
writeFileSync(join(out, 'report.json'), JSON.stringify(results.map(({ template, ...r }) => ({ ...r, id: template?.id })), null, 2));

console.log(
  `${results.length} templates: ${count('clean')} clean, ${count('review')} review, ${count('rejected')} rejected → ${out}/REPORT.md`,
);
