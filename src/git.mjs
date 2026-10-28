// The few git facts every command needs, in one place so verify and open-pr
// compute them the same way.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;

export const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }).trim();

export const repoRoot = (cwd = process.cwd()) => git(['rev-parse', '--show-toplevel'], cwd);

// The checkout that owns the .git folder; it holds untracked files a build
// needs (local.properties) that fresh worktrees lack.
export const mainCheckout = (root) => path.dirname(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)));

// origin's default branch as a ref, e.g. origin/main.
export function defaultBranch(root) {
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  } catch {
    return 'origin/main';
  }
}

export const mergeBase = (root, head = 'HEAD') => git(['merge-base', head, defaultBranch(root)], root);

// The branch's diff exactly as verify hashed it into the receipt.
export const branchDiff = (root, base, head) =>
  // core.quotePath=false: accented file names stay readable instead of octal escapes.
  execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-color', base, head], { cwd: root, maxBuffer: MAX_BUFFER });

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
