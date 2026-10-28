// dekaput verify: the proof gate. Run it from the fix worktree, with the test
// (and the fix, if any) committed on the branch.
//
// It copies the branch's new and changed test files onto the merge base with
// origin's default branch and runs them there. The test must fail with the
// crash's exception, from app code, reaching the anchor. Then it runs the
// test on HEAD and the task's whole suite (both must pass). When the test
// passes on the base, it runs on the release ref instead: crashing there means
// the crash is already fixed on the default branch (fixed-on-main).
// proof.mjs decides; a passing proof writes .dekaput/receipts/<HEAD>.json.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchDiff, git, mainCheckout, mergeBase, repoRoot, sha256 } from './git.mjs';
import { decide, diffFacts, TEST_PATH } from './proof.mjs';
import { dekaputDir, writeReceipt } from './receipt.mjs';
import { loadConfig, moduleForAnyApp } from './config.mjs';
import { gradleRun } from './runners/gradle.mjs';
import { pickDestination, xcodeRun } from './runners/xcode.mjs';

const WORKTREE_PREFIX = 'dekaput-';

export const VERIFY_OPTIONS = {
  issue: { type: 'string' },
  'gradle-task': { type: 'string' },
  test: { type: 'string' },
  exception: { type: 'string' },
  anchor: { type: 'string' },
  'anchor-kind': { type: 'string', default: 'frame' },
  release: { type: 'string' },
  // Defaults to the merge base with origin's default branch; set it only to check
  // the gate itself. open-pr refuses receipts proven against another base.
  base: { type: 'string' },
};

class VerifyError extends Error {}
const fail = (reason) => {
  throw new VerifyError(reason);
};

// Gradle needs the untracked local.properties (SDK path, keys) in every worktree.
function withLocalProperties(fromCheckout, dir) {
  const props = path.join(fromCheckout, 'local.properties');
  const target = path.join(dir, 'local.properties');
  if (fs.existsSync(props) && !fs.existsSync(target)) fs.copyFileSync(props, target);
}

// Worktrees a killed run left behind (a tool timeout skips finally blocks).
function removeStaleWorktrees(root) {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const line of git(['worktree', 'list', '--porcelain'], root).split('\n')) {
    const dir = line.startsWith('worktree ') ? line.slice(9) : null;
    if (dir && path.basename(dir).startsWith(WORKTREE_PREFIX) && path.dirname(dir) === tmp) {
      git(['worktree', 'remove', '--force', dir], root);
    }
  }
  git(['worktree', 'prune'], root);
}

// The module's runner: its Gradle task, or its Xcode scheme on an iOS simulator.
function runnerFor(module, filter) {
  if (module.gradleTask) {
    return {
      task: module.gradleTask,
      test: (dir) => gradleRun({ dir, task: module.gradleTask, filter }),
      suite: (dir) => gradleRun({ dir, task: module.gradleTask, filter: null }),
    };
  }
  const destination = module.xcode.destination ?? pickDestination();
  // Build products stay inside the worktree, in .dekaput/ (a throwaway worktree takes them with it).
  const run = (dir, only) => xcodeRun({ dir, module, filter: only, destination, derivedData: path.join(dekaputDir(dir), 'derived') });
  return {
    task: `xcodebuild test -scheme ${module.xcode.scheme}`,
    test: (dir) => run(dir, filter),
    // The suite is the test target that holds the test (the filter's first part), not UI tests or the whole scheme.
    suite: (dir) => run(dir, filter.split('/')[0]),
  };
}

// Files a run leaves behind: receipts and build products, Gradle's local.properties, the Kotlin 2
// compiler's .kotlin/, Xcode's .swiftpm/.
const LEFT_BY_RUNS = ['.dekaput/', 'local.properties', '.kotlin/', '.swiftpm/'];

export function verify(opts, log = (line) => console.error(`dekaput: ${line}`)) {
  for (const name of ['issue', 'test', 'exception', 'anchor']) if (!opts[name]) fail(`--${name} is required`);
  if (!['frame', 'message'].includes(opts['anchor-kind'])) fail('--anchor-kind is frame or message');

  const root = repoRoot();
  const checkout = mainCheckout(root);
  const dirty = git(['status', '--porcelain'], root).split('\n').filter((l) => l && !LEFT_BY_RUNS.some((f) => l.endsWith(f)));
  if (dirty.length) fail('commit the test (and the fix) first; the receipt is bound to HEAD');
  removeStaleWorktrees(root);

  const head = git(['rev-parse', 'HEAD'], root);
  const base = git(['rev-parse', opts.base ?? mergeBase(root, head)], root);
  const diffBytes = branchDiff(root, base, head);
  const diff = diffBytes.toString('utf8');
  const { testFiles } = diffFacts(diff);
  if (testFiles.length === 0) fail('the branch adds or changes no test');
  const knownTestFiles = git(['ls-files'], root).split('\n').filter((f) => TEST_PATH.test(f));

  // The flag wins; otherwise the config's module that holds the branch's tests.
  const config = opts['gradle-task'] ? null : loadConfig(root);
  const module = opts['gradle-task'] ? { path: '', gradleTask: opts['gradle-task'] } : config && moduleForAnyApp(config, testFiles);
  if (!module) fail(`no module in ${config ? config.file : '.github/de-kaput.yml'} holds ${testFiles.join(', ')}; add it under modules, or pass --gradle-task`);
  const runner = runnerFor(module, opts.test);
  const runTest = runner.test;
  const runSuite = runner.suite;

  // The branch's tests, run on another commit in a throwaway worktree.
  const onCommit = (ref) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), WORKTREE_PREFIX));
    try {
      git(['worktree', 'add', '--detach', '--quiet', dir, ref], root);
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      fail(`could not check out ${ref}: ${error.message.split('\n')[0]}`);
    }
    try {
      for (const file of testFiles) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), execFileSync('git', ['show', `${head}:${file}`], { cwd: root }));
      }
      withLocalProperties(checkout, dir);
      return runTest(dir);
    } finally {
      git(['worktree', 'remove', '--force', dir], root);
    }
  };

  const anchor = { kind: opts['anchor-kind'], text: opts.anchor };
  log(`running the test on the base ${base.slice(0, 8)}`);
  const baseRun = onCommit(base);
  let tagRun;
  let headRun;
  let suiteRun;
  if (baseRun.status === 'pass' && opts.release) {
    log(`the base passes; running the test on the release ${opts.release}`);
    tagRun = onCommit(opts.release);
  } else if (baseRun.status === 'fail') {
    log('running the test on HEAD, then the whole suite');
    withLocalProperties(checkout, root);
    headRun = runTest(root);
    suiteRun = headRun.status === 'pass' ? runSuite(root) : undefined;
  }

  const verdict = decide({ exception: opts.exception, anchor, diff, baseRun, headRun, suiteRun, tagRun, knownTestFiles });
  const brief = (run) => run && { status: run.status, failureType: run.failureType, stack: run.stack?.split('\n').slice(0, 4).join('\n') };
  const runs = { baseRun: brief(baseRun), tagRun: brief(tagRun), headRun: brief(headRun), suiteRun: brief(suiteRun) };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, runs };

  const receipt = {
    issue: opts.issue,
    result: verdict.result,
    head,
    base,
    release: opts.release ?? null,
    task: runner.task,
    test: opts.test,
    exception: opts.exception,
    anchor,
    runs,
    diffSha256: sha256(diffBytes),
    createdAt: new Date().toISOString(),
  };
  return { ok: true, receipt, file: writeReceipt(root, receipt) };
}

export { VerifyError };
