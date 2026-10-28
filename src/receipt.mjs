// The proof receipt: written by verify, required by open-pr.
//
// A receipt is bound to the commit it proved (HEAD), the base it proved
// against (the merge base with origin's default branch) and a hash of the
// diff between them. open-pr refuses if any of those no longer match, so a
// commit added after the proof needs a new proof.

import fs from 'node:fs';
import path from 'node:path';
import { branchDiff, git, mergeBase, sha256 } from './git.mjs';

export const RESULTS = ['proven', 'fixed-on-main'];

export const receiptPath = (root, head) => path.join(root, '.dekaput', 'receipts', `${head}.json`);

// .dekaput/ holds receipts, crash events and build products. None of it is ever
// committed, so it ignores itself: an agent's `git add -A` cannot pick it up.
export function dekaputDir(root) {
  const dir = path.join(root, '.dekaput');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return dir;
}

export function writeReceipt(root, receipt) {
  dekaputDir(root);
  const file = receiptPath(root, receipt.head);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

// { ok: true, receipt } or { ok: false, reason }
export function checkReceipt(root) {
  const head = git(['rev-parse', 'HEAD'], root);
  const file = receiptPath(root, head);
  if (!fs.existsSync(file)) return { ok: false, reason: `no proof receipt for HEAD (${head.slice(0, 8)}); run dekaput verify on this commit` };
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!RESULTS.includes(receipt.result)) return { ok: false, reason: `the receipt's result is ${receipt.result}, not ${RESULTS.join(' or ')}` };
  const base = mergeBase(root, head);
  if (receipt.base !== base) return { ok: false, reason: 'the receipt was proven against another base; run dekaput verify again (without --base)' };
  if (receipt.diffSha256 !== sha256(branchDiff(root, base, head))) {
    return { ok: false, reason: "the branch's diff is not the one the receipt proved; run dekaput verify again" };
  }
  return { ok: true, receipt };
}
