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

// A GitHub remote URL as owner/name: https://github.com/o/n(.git), git@github.com:o/n(.git), ssh://git@github.com/o/n.
export function githubRepoOf(url) {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1];
}

// origin's GitHub repo. Every gh call names it: in a fork, gh would otherwise pick the upstream repo.
export function originRepo(root) {
  let url;
  try {
    // git's own "No such remote" stays quiet; the reason below says it plainly.
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('this repo has no remote named origin; de-kaput reads and opens its pull requests on origin, a GitHub repo (git remote add origin <url>)');
  }
  return githubRepoOf(url);
}

export const mergeBase = (root, head = 'HEAD') => git(['merge-base', head, defaultBranch(root)], root);

// The branch's diff exactly as verify hashed it into the receipt.
export const branchDiff = (root, base, head) =>
  // core.quotePath=false: accented file names stay readable instead of octal escapes.
  execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-color', base, head], { cwd: root, maxBuffer: MAX_BUFFER });

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
