import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pushBranch } from '../src/open-pr.mjs';
import { tempDir } from './tmp.mjs';

// The first live run's setup: push.default=upstream, and a fix branch cut from
// origin/main, so it tracks main. A bare `git push origin <branch>` went to main.
test('the fix branch is pushed to its own branch, never to the default branch', () => {
  const tmp = tempDir('dekaput-push-');
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  git(work, 'config', 'push.default', 'upstream');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one');
  git(work, 'add', 'a.txt');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const mainBefore = git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  git(work, 'fetch', '-q', 'origin');
  git(work, 'checkout', '-q', '-b', 'de-kaput/abc-fix', 'origin/main');
  assert.equal(git(work, 'config', '--get', 'branch.de-kaput/abc-fix.merge'), 'refs/heads/main');
  fs.writeFileSync(path.join(work, 'b.txt'), 'two');
  git(work, 'add', 'b.txt');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two');

  pushBranch(work, 'de-kaput/abc-fix', 'main');

  assert.equal(git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], mainBefore);
  assert.equal(git(work, 'ls-remote', 'origin', 'refs/heads/de-kaput/abc-fix').split('\t')[0], git(work, 'rev-parse', 'HEAD'));
});

test('pushing the default branch itself is refused', () => {
  assert.throws(() => pushBranch('/nowhere', 'main', 'main'), /refusing to push the default branch/);
});

test("origin's GitHub repo is read from its URL, so a fork's PR never goes upstream", async () => {
  const { githubRepoOf } = await import('../src/git.mjs');
  assert.equal(githubRepoOf('https://github.com/vaazh-studios/de-kaput-demo-netnewswire.git'), 'vaazh-studios/de-kaput-demo-netnewswire');
  assert.equal(githubRepoOf('git@github.com:vaazh-studios/de-kaput.git'), 'vaazh-studios/de-kaput');
  assert.equal(githubRepoOf('ssh://git@github.com/octo/app.name'), 'octo/app.name');
  assert.throws(() => githubRepoOf('/tmp/origin.git'), /not a GitHub repository/);
});

test('a repo with no origin remote gets a plain reason, not a git error', async () => {
  const { originRepo } = await import('../src/git.mjs');
  const dir = tempDir('dekaput-no-origin-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.throws(() => originRepo(dir), /no remote named origin/);
});
