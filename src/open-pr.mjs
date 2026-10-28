// dekaput open-pr: push the branch and open a normal (not draft) pull request,
// only with a proof receipt that still matches the branch.
//
// The agent writes the human part of the body (what crashed, why, what the fix
// does, what was not verified). open-pr appends the proof from the receipt,
// so a PR can never go out without it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultBranch, git, originRepo, repoRoot } from './git.mjs';
import { loadConfig } from './config.mjs';
import { PR_LABEL } from './list.mjs';
import { checkReceipt } from './receipt.mjs';

export const OPEN_PR_OPTIONS = {
  title: { type: 'string' },
  'body-file': { type: 'string' },
  // Further Crashlytics issue ids this PR also answers (an R8-renamed twin).
  also: { type: 'string', multiple: true, default: [] },
};

const fence = (text) => ['```text', text ?? '', '```'].join('\n');

// A frame anchor names code; a message anchor is either a class the message names or the message's own words.
const anchorPhrase = (anchor) => {
  if (anchor.kind === 'frame') return `through the frame \`${anchor.text}\``;
  if (/^[\w$]+(\.[\w$]+)+$/.test(anchor.text)) return `with the class \`${anchor.text}\` in its message`;
  return `with the message text "${anchor.text}"`;
};

export function proofSection(receipt, also = []) {
  const { runs } = receipt;
  const lines = [
    '## Proof (de-kaput)',
    '',
    receipt.result === 'fixed-on-main'
      ? `This crash is already fixed on \`${receipt.base.slice(0, 8)}\` and not in the release \`${receipt.release}\`. The test crashes on the release and passes here, so it keeps the crash fixed.`
      : `The test fails on \`${receipt.base.slice(0, 8)}\` with the crash's exception and passes with the fix; the whole suite is green.`,
    '',
    `- Test: \`${receipt.test}\` (\`${receipt.task}\`)`,
    `- Crash: \`${receipt.exception}\`, ${anchorPhrase(receipt.anchor)}`,
    `- Base: \`${receipt.base}\`${receipt.release ? `; release: \`${receipt.release}\`` : ''}`,
    '',
  ];
  if (runs.tagRun) lines.push('On the release (must crash):', fence(runs.tagRun.stack), '');
  if (runs.baseRun?.status === 'fail') lines.push('On the base (must crash):', fence(runs.baseRun.stack), '');
  if (receipt.result === 'proven') lines.push(`With the fix the test ${runs.headRun?.status === 'pass' ? 'passes' : runs.headRun?.status}, and the whole suite ${runs.suiteRun?.status === 'pass' ? 'is green' : runs.suiteRun?.status}.`);
  else lines.push('On the base the test passes.');
  lines.push('', `Crashlytics issue ${[receipt.issue, ...also].join(', ')}. Receipt \`${receipt.head.slice(0, 8)}\`, diff sha256 \`${receipt.diffSha256.slice(0, 16)}\`.`);
  return lines.join('\n');
}

// Push the fix branch to a branch of the same name on origin, always named in
// full. A bare `git push origin <branch>` follows push.default, and with
// push.default=upstream and a branch cut from origin/main that pushes to main
// (it did, on the first live run).
export function pushBranch(root, branch, base) {
  if (branch === base) throw new Error(`refusing to push the default branch ${base}`);
  execFileSync('git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
}

export function openPr(opts) {
  if (!opts.title) throw new Error('--title is required');
  if (!opts['body-file']) throw new Error('--body-file is required (what crashed, why, what changed, what was not verified)');
  const root = repoRoot();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const base = defaultBranch(root).replace(/^origin\//, '');
  if (branch === 'HEAD' || branch === base) throw new Error(`run open-pr on the fix branch, not ${branch}`);
  const check = checkReceipt(root);
  if (!check.ok) throw new Error(check.reason);

  const body = `${fs.readFileSync(opts['body-file'], 'utf8').trim()}\n\n${proofSection(check.receipt, opts.also)}\n`;
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-pr-')), 'body.md');
  fs.writeFileSync(bodyFile, body);

  // The PR goes to origin, never to the repo a fork came from.
  const repo = originRepo(root);
  pushBranch(root, branch, base);
  // The label is how list finds de-kaput PRs; creating it when it exists fails harmlessly.
  try {
    execFileSync('gh', ['label', 'create', PR_LABEL, '--repo', repo, '--color', 'B60205', '--description', 'Crash fix proven by a test (de-kaput)'], { cwd: root, stdio: 'ignore' });
  } catch { /* already there */ }
  // GitHub refuses a review request to the PR's own author, so the account opening it is left out.
  const me = execFileSync('gh', ['api', 'user', '-q', '.login'], { cwd: root, encoding: 'utf8' }).trim();
  const reviewers = (loadConfig(root)?.reviewers ?? []).filter((r) => r.toLowerCase() !== me.toLowerCase());
  const reviewerArgs = reviewers.length ? ['--reviewer', reviewers.join(',')] : [];
  return execFileSync('gh', ['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', opts.title, '--body-file', bodyFile, '--label', PR_LABEL, ...reviewerArgs], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}
