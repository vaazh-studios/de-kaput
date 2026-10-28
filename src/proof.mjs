// The proof rule, as a pure decision over test runs and the branch diff.
//
// A run is { status: 'pass'|'fail'|'error', failureType?, stack?, ran? }:
// 'fail' is a test that ran and failed, 'error' is one that never ran (did
// not compile, no results). stack is the failure text: message first, then
// frames. ran lists the test classes (Gradle) or files (vitest) that ran.
//
// Proven: the new test fails on the branch base with the crash's exception,
// thrown from app code, reaching the crash's anchor (a frame, or the app class
// the crash message names); it passes on HEAD; the module's suite is green.
// Fixed on main: the test passes on base but crashes on the release tag.
//
// The gate guards against honest mistakes (a test that does not reproduce the
// crash, a fix that only silences it), not against forging a receipt.

export const TEST_PATH = /(\/src\/[^/]*[Tt]est\/|(^|\/)test\/|\.(test|spec)\.[cm]?[jt]s$)/;
const CODE_FILE = /\.(kt|kts|java|swift|ts|js|mjs)$/;
// Build, test-runner and gate files: changing them can exclude or weaken tests.
const CONFIG_FILE = /(\.gradle(\.kts)?$|gradle\.properties$|libs\.versions\.toml$|(^|\/)package(-lock)?\.json$|(vitest|jest|vite)\.config\.|(^|\/)tsconfig[^/]*\.json$|(^|\/)\.claude\/|(^|\/)\.github\/)/;
const FORBIDDEN_IN_TESTS = [
  [/@(?:[\w.]+\.)?(?:Ignore|Disabled)\b/, 'switches a test off'],
  [/Thread\.sleep\(/, 'sleeps in a test'],
  [/\bretry\b|@RepeatedTest|@Flaky/i, 'retries a test'],
  [/\b(it|test|describe)\.(skip|todo)\(/, 'skips a test'],
  [/\bassume(?:True|False|That|NotNull)?\s*\(|\bAssume\./, 'makes a test conditional'],
];

const simpleName = (type) => (type ?? '').split('.').pop();
const baseName = (file) => file.split('/').pop();
// "ParserTest.kt" and "com.x.ParserTest" -> "ParserTest"; "x.test.ts" -> "x".
export const testId = (name) => baseName(name.includes('/') || /\.(kt|[cm]?[jt]s)$/.test(name) ? name : name.split('.').pop()).split('.')[0];

export function diffFacts(diff) {
  const testFiles = new Set();
  const sourceFiles = new Set();
  const problems = [];
  let oldFile = null;
  let file = null;
  let isNew = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) { oldFile = null; file = null; isNew = false; continue; }
    if (line.startsWith('--- ')) {
      isNew = line === '--- /dev/null';
      oldFile = isNew ? null : line.replace(/^--- (a\/)?/, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? oldFile : line.replace(/^\+\+\+ (b\/)?/, '');
      if (line === '+++ /dev/null' && file && TEST_PATH.test(file)) problems.push(`deletes the test file ${file}`);
      continue;
    }
    if (!file || !/^[+-]/.test(line)) continue;
    if (CONFIG_FILE.test(file)) {
      problems.push(`changes build, test or gate configuration in ${file}`);
      continue;
    }
    if (!TEST_PATH.test(file)) {
      if (CODE_FILE.test(file)) sourceFiles.add(file);
      continue;
    }
    if (line.startsWith('-')) {
      if (!isNew) problems.push(`changes an existing line in ${file}`);
      continue;
    }
    testFiles.add(file);
    for (const [pattern, what] of FORBIDDEN_IN_TESTS) {
      if (pattern.test(line)) problems.push(`${what} in ${file}`);
    }
  }
  return { testFiles: [...testFiles], sourceFiles: [...sourceFiles], problems: [...new Set(problems)] };
}

const FRAME_LINE = /^\s*at\s+/;

// "at com.x.Bar.run(Bar.kt:12)", "at parse (src/parse.ts:3:9)", "at /abs/x.test.ts:3:9".
function frameOf(line) {
  const body = line.replace(FRAME_LINE, '').trim();
  const call = /^(.*?)\s*\(([^()]*)\)$/.exec(body);
  const location = call ? call[2] : body;
  const file = baseName(location.replace(/^file:\/\//, '').replace(/(:\d+)+$/, ''));
  return { symbol: (call ? call[1] : '').replace(/^kfun:/, '').trim(), file };
}

function splitStack(stack) {
  const lines = (stack ?? '').split('\n');
  const first = lines.findIndex((l) => FRAME_LINE.test(l));
  const frames = first < 0 ? [] : lines.slice(first).filter((l) => FRAME_LINE.test(l)).map(frameOf);
  return { message: (first < 0 ? lines : lines.slice(0, first)).join('\n'), frames };
}

const reaches = (anchor, { message, frames }) =>
  anchor.kind === 'message'
    ? message.includes(anchor.text)
    : frames.some((f) => f.symbol === anchor.text || f.symbol.startsWith(`${anchor.text}$`));

// Why a run on base is not the crash, or null when it is.
function notTheCrash(run, { exception, anchor, testFiles, knownTestFiles }) {
  if (run.status === 'error') return 'fails before for another reason: the test did not compile or did not run';
  if (run.status === 'pass') return 'passes before the fix: the test does not reproduce the crash';
  if (simpleName(run.failureType) !== simpleName(exception)) {
    return `fails before with ${run.failureType ?? 'an unknown error'}, not the crash's ${exception}`;
  }
  const stack = splitStack(run.stack);
  const top = stack.frames[0]?.file;
  const testNames = new Set([...testFiles, ...knownTestFiles].map(baseName));
  if (top && testNames.has(top)) return `the ${exception} is thrown by the test itself (${top}), not by app code`;
  if (!reaches(anchor, stack)) {
    const where = anchor.kind === 'message' ? 'message' : 'frames';
    return `never reached app code: the failure's ${where} do not include ${anchor.text}`;
  }
  return null;
}

export function decide({ exception, anchor, diff, baseRun, headRun, suiteRun, tagRun, knownTestFiles = [] }) {
  const facts = diffFacts(diff);
  if (facts.problems.length) return { ok: false, reason: facts.problems.join('; ') };
  if (facts.testFiles.length === 0) return { ok: false, reason: 'no new or changed test in the branch' };
  if (baseRun.ran && !facts.testFiles.some((f) => baseRun.ran.map(testId).includes(testId(f)))) {
    return { ok: false, reason: "the test filter does not run the branch's new test" };
  }
  const context = { exception, anchor, testFiles: facts.testFiles, knownTestFiles };

  const onBase = notTheCrash(baseRun, context);
  if (baseRun.status === 'pass' && tagRun) {
    const onTag = notTheCrash(tagRun, context);
    return onTag ? { ok: false, reason: `on the release tag the test ${onTag}` } : { ok: true, result: 'fixed-on-main' };
  }
  if (onBase) return { ok: false, reason: onBase };
  if (facts.sourceFiles.length === 0) return { ok: false, reason: 'no fix in source: the branch changes only tests' };
  if (headRun?.status !== 'pass') return { ok: false, reason: 'the test still fails with the fix' };
  if (suiteRun?.status !== 'pass') return { ok: false, reason: "the module's full suite is not green with the fix" };
  return { ok: true, result: 'proven' };
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

// Gradle's JUnit XML reports for one filtered run.
export function parseJUnit(xmlFiles) {
  const ran = new Set();
  let failure = null;
  for (const xml of xmlFiles) {
    for (const [, attrs, body = ''] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      if (/<skipped\b/.test(body)) continue;
      ran.add(unescapeXml(/classname="([^"]*)"/.exec(attrs)?.[1] ?? ''));
      const found = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
      if (!found || failure) continue;
      const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(found[2])?.[1];
      failure = {
        status: 'fail',
        failureType: unescapeXml(attr('type') ?? ''),
        stack: unescapeXml((found[3] ?? attr('message') ?? '').trim()),
      };
    }
  }
  if (ran.size === 0) return { status: 'error' };
  return { ...(failure ?? { status: 'pass' }), ran: [...ran] };
}

// vitest --reporter=json output.
export function parseVitest(jsonText) {
  const files = JSON.parse(jsonText).testResults ?? [];
  const ranFiles = files.filter((f) => (f.assertionResults ?? []).some((r) => r.status === 'passed' || r.status === 'failed'));
  if (ranFiles.length === 0) return { status: 'error' };
  const ran = ranFiles.map((f) => f.name ?? '');
  const failed = ranFiles.flatMap((f) => f.assertionResults).find((r) => r.status === 'failed');
  if (!failed) return { status: 'pass', ran };
  const stack = (failed.failureMessages ?? []).join('\n').trim();
  return { status: 'fail', failureType: /^([\w$.]+)/.exec(stack)?.[1] ?? '', stack, ran };
}
