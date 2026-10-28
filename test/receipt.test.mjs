import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchDiff, sha256 } from '../src/git.mjs';
import { checkReceipt, writeReceipt } from '../src/receipt.mjs';

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function commit(message) {
  fs.writeFileSync(path.join(repo, 'f.txt'), message);
  git('add', 'f.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}
// What verify writes: bound to HEAD, the merge base and the diff's hash.
function receipt({ result = 'proven', base = git('merge-base', 'HEAD', 'origin/main') } = {}) {
  const head = git('rev-parse', 'HEAD');
  writeReceipt(repo, { head, base, result, diffSha256: sha256(branchDiff(repo, base, head)) });
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-receipt-')));
  git('init', '-q', '-b', 'main');
  git('update-ref', 'refs/remotes/origin/main', commit('one'));
  git('checkout', '-q', '-b', 'de-kaput/e044059c-tabs');
  commit('fix');
});

test('no receipt for HEAD is refused', () => {
  assert.match(checkReceipt(repo).reason, /no proof receipt/);
});

test('a proven receipt for HEAD passes, and so does fixed-on-main', () => {
  receipt();
  assert.equal(checkReceipt(repo).ok, true);
  receipt({ result: 'fixed-on-main' });
  assert.equal(checkReceipt(repo).ok, true);
});

test('a receipt for an older commit is not enough', () => {
  receipt();
  commit('two');
  assert.equal(checkReceipt(repo).ok, false);
});

test('a receipt proven against another base is refused', () => {
  receipt({ base: git('rev-parse', 'HEAD') });
  assert.match(checkReceipt(repo).reason, /another base/);
});

test('a receipt whose diff no longer matches is refused', () => {
  receipt();
  const file = path.join(repo, '.dekaput', 'receipts', `${git('rev-parse', 'HEAD')}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), diffSha256: 'beef' }));
  assert.match(checkReceipt(repo).reason, /diff is not the one/);
});

test('any other result is refused', () => {
  receipt({ result: 'rejected' });
  assert.match(checkReceipt(repo).reason, /not proven or fixed-on-main/);
});

test('.dekaput/ ignores itself, so receipts and build products never show up to git', () => {
  receipt();
  fs.mkdirSync(path.join(repo, '.dekaput', 'derived'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.dekaput', 'derived', 'build.o'), 'x');
  assert.equal(git('status', '--porcelain'), '');
});
