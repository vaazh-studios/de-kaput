// The proof rule, as a pure decision over test runs and the branch diff.
//
// A run is { status: 'pass'|'fail'|'error', failureType?, stack?, ran? }:
// 'fail' is a test that ran and failed, 'error' is one that never ran (did
// not compile, no results). stack is the failure text: message first, then
// frames. ran lists the test classes (Gradle, Xcode) or files (vitest) that ran.
// The Xcode runner also gives message, frames [{ symbol, file, own }] and
// signal (a crash's EXC_BREAKPOINT is also its SIGTRAP), since Swift symbols
// carry parentheses that the text form cannot split. own marks the app's and
// the tests' code; an exception XCTest caught has frames without files.
//
// Proven: the new test fails on the branch base with the crash's exception,
// thrown from app code, reaching the crash's anchor (a frame, or the app class
// the crash message names); it passes on HEAD; no test in the module's suite
// that passes on the base fails with the fix (suiteAgainstBase).
// Reproduced: the test fails on the base with the crash, and the branch has no fix yet.
// Fixed on main: the test passes on base but crashes on the release tag.
//
// The gate guards against honest mistakes (a test that does not reproduce the
// crash, a fix that only silences it), not against forging a receipt.

// src/test/ and src/commonTest/ (Gradle), test/ and *.test.ts (JS), a *Tests/ target folder (Xcode, SwiftPM).
export const TEST_PATH = /(\/src\/[^/]*[Tt]est\/|(^|\/)test\/|\.(test|spec)\.[cm]?[jt]s$|(^|\/)[^/]*Tests\/)/;
const CODE_FILE = /\.(kt|kts|java|swift|m|mm|h|ts|js|mjs)$/;
// Build, test-runner and gate files: changing them can exclude or weaken tests.
const CONFIG_FILE = new RegExp([
  /\.gradle(\.kts)?$|gradle\.properties$|libs\.versions\.toml$/,
  /(^|\/)package(-lock)?\.json$|(vitest|jest|vite)\.config\.|(^|\/)tsconfig[^/]*\.json$/,
  /\.pbxproj$|\.xcscheme$|\.xctestplan$|\.xcconfig$|(^|\/)Package\.(swift|resolved)$|(^|\/)Podfile(\.lock)?$/,
  /(^|\/)\.claude\/|(^|\/)\.github\//,
].map((r) => r.source).join('|'));
const FORBIDDEN_IN_TESTS = [
  [/@(?:[\w.]+\.)?(?:Ignore|Disabled)\b|\.disabled\(/, 'switches a test off'],
  [/Thread\.sleep\(|\bu?sleep\(|Task\.sleep\b/, 'sleeps in a test'],
  [/\bretry\b|@RepeatedTest|@Flaky/i, 'retries a test'],
  [/\b(it|test|describe)\.(skip|todo)\(|\bXCTSkip/, 'skips a test'],
  [/\bassume(?:True|False|That|NotNull)?\s*\(|\bAssume\.|\.enabled\(\s*if:/, 'makes a test conditional'],
  [/\bXCTExpectFailure\b|\bwithKnownIssue\b/, 'expects the failure instead of fixing it'],
];

const simpleName = (type) => (type ?? '').split('.').pop();
const baseName = (file) => file.split('/').pop();
// "ParserTest.kt" and "com.x.ParserTest" -> "ParserTest"; "x.test.ts" -> "x".
export const testId = (name) => baseName(name.includes('/') || /\.(kt|[cm]?[jt]s)$/.test(name) ? name : name.split('.').pop()).split('.')[0];

// A ---/+++ path as git writes it: a tab after a path with a space ("Toast CatalogTests/"),
// quotes around one with a quote, a backslash or a control character.
function headerPath(raw) {
  const text = raw.replace(/\t$/, '');
  if (!/^".*"$/.test(text)) return text;
  const escaped = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
  return text.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => escaped[c]);
}

// A test class or function a test line declares: "+final class CartCrashTests: XCTestCase {",
// "+class ParserTest {", "+@Test func emptyCart() {" (Swift Testing runs a function outside a suite by its name).
const DECLARED_TEST = /\b(?:class|struct|extension|object|func)\s+([A-Za-z_]\w*)/g;

export function diffFacts(diff) {
  const testFiles = new Set();
  const declaredTests = new Set();
  const sourceFiles = new Set();
  const problems = [];
  let oldFile = null;
  let file = null;
  let isNew = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) { oldFile = null; file = null; isNew = false; continue; }
    if (line.startsWith('--- ')) {
      isNew = line === '--- /dev/null';
      oldFile = isNew ? null : headerPath(line.slice(4)).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? oldFile : headerPath(line.slice(4)).replace(/^b\//, '');
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
    for (const [, name] of line.matchAll(DECLARED_TEST)) declaredTests.add(name);
    for (const [pattern, what] of FORBIDDEN_IN_TESTS) {
      if (pattern.test(line)) problems.push(`${what} in ${file}`);
    }
  }
  return { testFiles: [...testFiles], declaredTests: [...declaredTests], sourceFiles: [...sourceFiles], problems: [...new Set(problems)] };
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

// A Swift symbol as the release build and the test build both name it: a release
// build specializes and thunks what a debug build calls plainly.
const SWIFT_WRAPPER = /^(?:specialized |merged |@objc |partial apply for |(?:reabstraction )?thunk for |generic specialization <[^>]*> of )+/;
export const swiftName = (symbol) => symbol.replace(SWIFT_WRAPPER, '').replace(/\s+->\s+.*$/, '').trim();

const reachesFrame = (symbol, anchor) => {
  if (symbol === anchor || symbol.startsWith(`${anchor}$`)) return true;
  const name = swiftName(symbol);
  // "closure #1 in Parser.load()" runs inside Parser.load().
  return name === swiftName(anchor) || name.endsWith(` in ${swiftName(anchor)}`);
};

const reaches = (anchor, { message, frames }) =>
  anchor.kind === 'message' ? message.includes(anchor.text) : frames.some((f) => reachesFrame(f.symbol, anchor.text));

// The type a frame belongs to: "closure #1 in static CartTests.testA()" and "-[CartTests testA]" -> "CartTests".
const typeOf = (symbol) => {
  const objc = /^[-+]\[(\w+)/.exec(symbol);
  if (objc) return objc[1];
  return swiftName(symbol).replace(/^(?:(?:implicit )?closure #\d+ in |static |class )+/, '').split(/[.(<\s]/)[0];
};

const framesOf = (run) => (run.frames ? { message: run.message ?? '', frames: run.frames } : splitStack(run.stack));

// Why a run on base is not the crash, or null when it is.
function notTheCrash(run, { exception, anchor, testFiles, declaredTests = [], knownTestFiles }) {
  if (run.status === 'error') return 'fails before for another reason: the test did not compile or did not run';
  if (run.status === 'pass') return 'passes before the fix: the test does not reproduce the crash';
  if (run.noCrashLog) {
    return 'crashes, but macOS kept no crash log to check the crash against (its crash reporter rate-limits logs after many crashes); run verify again in a few minutes';
  }
  if (![run.failureType, run.signal].some((t) => t && simpleName(t) === simpleName(exception))) {
    return `fails before with ${run.failureType ?? 'an unknown error'}, not the crash's ${exception}`;
  }
  const stack = framesOf(run);
  // The first frame of own code: one with a source file, or one the runner marks own (a Swift trap's first frames are the runtime's).
  const top = stack.frames.find((f) => (f.file && !f.file.startsWith('<')) || f.own);
  const testNames = new Set([...testFiles, ...knownTestFiles].map(baseName));
  const testClasses = new Set([...[...testFiles, ...knownTestFiles].map(testId), ...declaredTests]);
  const ownTest = top && (top.file ? testNames.has(top.file) : testClasses.has(typeOf(top.symbol)));
  if (ownTest) return `the ${exception} is thrown by the test itself (${top.file ?? top.symbol}), not by app code`;
  if (!reaches(anchor, stack)) {
    const where = anchor.kind === 'message' ? 'message' : 'frames';
    return `never reached app code: the failure's ${where} do not include ${anchor.text}`;
  }
  return null;
}

// The suite with the fix, against the same suite on the base: a test that already fails there is not
// the fix's doing. Only a test that passes on the base and fails with the fix counts against it.
export function suiteAgainstBase(headSuite, baseSuite) {
  const failing = headSuite.failedTests ?? [];
  if (headSuite.status !== 'fail' || failing.length === 0 || !['pass', 'fail'].includes(baseSuite?.status)) return headSuite;
  const before = new Set(baseSuite.failedTests ?? []);
  const newFailures = failing.filter((t) => !before.has(t));
  const alreadyFailing = failing.filter((t) => before.has(t));
  return newFailures.length ? { ...headSuite, newFailures, alreadyFailing } : { status: 'pass', ran: headSuite.ran, alreadyFailing };
}

export function decide({ exception, anchor, diff, baseRun, headRun, suiteRun, tagRun, knownTestFiles = [] }) {
  const facts = diffFacts(diff);
  if (facts.problems.length) return { ok: false, reason: facts.problems.join('; ') };
  if (facts.testFiles.length === 0) return { ok: false, reason: 'no new or changed test in the branch' };
  // The filter must run the branch's test: a test file's own class, or a class the branch adds to a test file
  // (an Xcode project that lists its files in project.pbxproj takes a new test class in an existing file).
  const branchTests = [...facts.testFiles.map(testId), ...facts.declaredTests];
  if (baseRun.ran && !baseRun.ran.map(testId).some((name) => branchTests.includes(name))) {
    return { ok: false, reason: "the test filter does not run the branch's new test" };
  }
  const context = { exception, anchor, testFiles: facts.testFiles, declaredTests: facts.declaredTests, knownTestFiles };

  const onBase = notTheCrash(baseRun, context);
  if (baseRun.status === 'pass' && tagRun) {
    const onTag = notTheCrash(tagRun, context);
    return onTag ? { ok: false, reason: `on the release tag the test ${onTag}` } : { ok: true, result: 'fixed-on-main' };
  }
  if (onBase) return { ok: false, reason: onBase };
  if (facts.sourceFiles.length === 0) {
    return { ok: false, reproduced: true, reason: 'reproduced, no fix in source yet: the test fails on the base with the crash; write the fix, commit it, and run verify again' };
  }
  if (headRun?.status !== 'pass') return { ok: false, reason: 'the test still fails with the fix' };
  if (suiteRun?.status !== 'pass') {
    const broken = suiteRun?.newFailures?.length ? `: ${suiteRun.newFailures.slice(0, 5).join(', ')} pass on the base and fail with the fix` : '';
    return { ok: false, reason: `the module's full suite is not green with the fix${broken}` };
  }
  return { ok: true, result: 'proven' };
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

// Gradle's JUnit XML reports for one run: the first failure, and every failing test by name.
export function parseJUnit(xmlFiles) {
  const ran = new Set();
  const failedTests = [];
  let failure = null;
  for (const xml of xmlFiles) {
    for (const [, attrs, body = ''] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      if (/<skipped\b/.test(body)) continue;
      const className = unescapeXml(/classname="([^"]*)"/.exec(attrs)?.[1] ?? '');
      ran.add(className);
      const found = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
      if (found) failedTests.push(`${className}.${unescapeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '')}`);
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
  return { ...(failure ?? { status: 'pass' }), ran: [...ran], failedTests };
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
