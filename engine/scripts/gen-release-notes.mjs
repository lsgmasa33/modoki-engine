#!/usr/bin/env node
// Generate curated GitHub Release notes from the Conventional-Commit log between
// the previous v* tag and this one. User-facing types only (feat / fix / perf) —
// chore/test/docs/refactor/memory bookkeeping is intentionally hidden, since the
// commit stream is mostly agent-memory audits that mean nothing to an editor user.
//
//   node engine/scripts/gen-release-notes.mjs <tag> [out-file]
//
// <tag>     defaults to $GITHUB_REF_NAME (e.g. "v0.2.25").
// out-file  defaults to "release-notes.md". The notes are ALSO printed to stdout.
//
// In CI, run `git fetch --tags --force && git fetch --prune --unshallow || true`
// before this so the shallow tag checkout can see prior tags + history.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
const outFile = process.argv[3] || 'release-notes.md';

if (!tag) {
  console.error('[gen-release-notes] no tag given (argv[2] / $GITHUB_REF_NAME)');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gitSafe = (...args) => {
  try { return git(...args); } catch { return ''; }
};

// Previous tag = the closest annotated/lightweight tag reachable from this tag's parent.
// (Falls back to the whole history if this is the first tag.)
const prev = gitSafe('describe', '--tags', '--abbrev=0', `${tag}^`);
const range = prev ? `${prev}..${tag}` : tag;

// %s = subject line only; --no-merges drops the branch-merge commits.
const subjects = gitSafe('log', '--no-merges', '--pretty=format:%s', range)
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

// Conventional Commit: type(scope)!: description
const CC = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const SECTIONS = [
  { types: ['feat'], title: '### ✨ Features' },
  { types: ['fix'], title: '### 🐛 Fixes' },
  { types: ['perf'], title: '### ⚡ Performance' },
];
const KEEP = new Set(SECTIONS.flatMap((s) => s.types));

const buckets = new Map(SECTIONS.map((s) => [s.title, []]));
let breaking = 0;

for (const subject of subjects) {
  const m = CC.exec(subject);
  if (!m) continue;
  const [, type, scope, bang, desc] = m;
  if (!KEEP.has(type)) continue;
  const section = SECTIONS.find((s) => s.types.includes(type));
  const prefix = scope ? `**${scope}:** ` : '';
  const mark = bang ? ' ⚠️ **BREAKING**' : '';
  if (bang) breaking++;
  buckets.get(section.title).push(`- ${prefix}${desc}${mark}`);
}

// Compare link (GitHub) — only when we know the previous tag + the repo slug.
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const repo = process.env.GITHUB_REPOSITORY; // "owner/name"
let changelog = '';
if (repo && prev) {
  changelog = `\n**Full Changelog**: ${server}/${repo}/compare/${prev}...${tag}\n`;
} else if (repo) {
  changelog = `\n**Full Changelog**: ${server}/${repo}/releases\n`;
}

const body = [];
const anyEntries = [...buckets.values()].some((v) => v.length > 0);
if (anyEntries) {
  for (const { title } of SECTIONS) {
    const items = buckets.get(title);
    if (items.length) body.push(title, ...items, '');
  }
} else {
  body.push('Maintenance release — no user-facing changes in this build.', '');
}
if (breaking) {
  body.unshift(`> ⚠️ This release contains **${breaking}** breaking change(s) — see the ⚠️ entries below.`, '');
}
body.push(changelog);

const out = body.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
writeFileSync(outFile, out);
process.stdout.write(out);
console.error(`\n[gen-release-notes] ${tag} (range ${range}) → ${outFile}`);
