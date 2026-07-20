#!/usr/bin/env node
// Installs the tracked git hooks (engine/scripts/git-hooks/*) into the repo's
// hooks directory. Run automatically via the `prepare` npm script on install,
// or manually with `npm run hooks:install`.
//
// We copy into the git COMMON dir's hooks/ (not core.hooksPath) so:
//   - the existing Git LFS hooks there keep working (we never touch hooksPath),
//   - the hook is shared by every worktree (main + work-ai) off the one .git.
// No-ops quietly when there's no git dir (CI tarball, etc.) so install never fails.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const SRC_DIR = fileURLToPath(new URL('./git-hooks/', import.meta.url));

function gitCommonHooksDir() {
  try {
    const common = execSync('git rev-parse --git-common-dir', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (!common) return null;
    // Path may be relative to cwd (e.g. ".git" in the main checkout).
    return join(resolve(process.cwd(), common), 'hooks');
  } catch {
    return null; // not a git repo / git not on PATH — skip silently.
  }
}

const hooksDir = gitCommonHooksDir();
if (!hooksDir || !existsSync(SRC_DIR)) {
  console.log('[hooks] no git hooks dir — skipping hook install');
  process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });
for (const name of readdirSync(SRC_DIR)) {
  const dest = join(hooksDir, name);
  copyFileSync(join(SRC_DIR, name), dest);
  chmodSync(dest, 0o755);
  console.log(`[hooks] installed ${name} → ${dest}`);
}
