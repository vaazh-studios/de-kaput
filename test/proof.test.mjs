import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, diffFacts, parseJUnit, parseVitest } from '../src/proof.mjs';

const exception = 'java.lang.IllegalArgumentException';
const frameAnchor = { kind: 'frame', text: 'com.example.app.data.Parser.parse' };
const messageAnchor = { kind: 'message', text: 'com.example.app.ui.tabs.HomeTab' };

const crashed = {
  status: 'fail',
  failureType: 'java.lang.IllegalArgumentException',
  stack: 'java.lang.IllegalArgumentException: bad\n\tat com.example.app.data.Parser.parse(Parser.kt:12)\n\tat com.example.app.data.ParserTest.a crash input parses(ParserTest.kt:9)',
};
const pass = { status: 'pass' };

const fixDiff = [
  'diff --git a/shared/data/src/commonMain/kotlin/com/x/Parser.kt b/shared/data/src/commonMain/kotlin/com/x/Parser.kt',
  '--- a/shared/data/src/commonMain/kotlin/com/x/Parser.kt',
  '+++ b/shared/data/src/commonMain/kotlin/com/x/Parser.kt',
  '@@ -1,3 +1,3 @@',
  '-    return text.toInt()',
  '+    return text.toIntOrNull() ?: 0',
  'diff --git a/shared/data/src/commonTest/kotlin/com/x/ParserTest.kt b/shared/data/src/commonTest/kotlin/com/x/ParserTest.kt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/shared/data/src/commonTest/kotlin/com/x/ParserTest.kt',
  '@@ -0,0 +1,3 @@',
  '+    @Test fun `a crash input parses`() { assertEquals(0, parse("x")) }',
].join('\n');
const testOnlyDiff = fixDiff.split('\n').slice(6).join('\n');

const base = { exception, anchor: frameAnchor, diff: fixDiff };

test('fails before with the crash and its frame, passes after, suite green: proven', () => {
  assert.deepEqual(decide({ ...base, baseRun: crashed, headRun: pass, suiteRun: pass }), { ok: true, result: 'proven' });
});

test('passes on base and crashes on the release tag: fixed on main', () => {
  assert.deepEqual(decide({ ...base, diff: testOnlyDiff, baseRun: pass, tagRun: crashed }), { ok: true, result: 'fixed-on-main' });
});

test('passes on base with no tag run: the test does not reproduce the crash', () => {
  const r = decide({ ...base, baseRun: pass, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /passes before the fix/);
});

test('a compile failure on base is not the crash', () => {
  const r = decide({ ...base, baseRun: { status: 'error' }, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fails before for another reason/);
});

test('the right exception without the crash frame never reached app code', () => {
  const r = decide({ ...base, baseRun: { ...crashed, stack: 'java.lang.IllegalArgumentException: bad\n\tat kotlin.text.StringsKt.toInt(Strings.kt:1)' }, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never reached app code/);
});

test('another exception type is rejected', () => {
  const r = decide({ ...base, baseRun: { ...crashed, failureType: 'java.lang.AssertionError' }, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /AssertionError/);
});

test('a test that throws the exception itself is rejected, even with the class in its message', () => {
  const selfThrown = {
    status: 'fail',
    failureType: exception,
    stack: `java.lang.IllegalArgumentException: Key ${messageAnchor.text}:currentTab was used multiple times\n\tat com.x.TabTest.crashes(TabTest.kt:5)`,
  };
  const diff = fixDiff.replaceAll('ParserTest', 'TabTest');
  const r = decide({ exception, anchor: messageAnchor, diff, baseRun: selfThrown, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /thrown by the test itself/);
});

test('a message anchor is matched in the failure message', () => {
  const composeCrash = {
    status: 'fail',
    failureType: exception,
    stack: `java.lang.IllegalArgumentException: Key ${messageAnchor.text}:currentTab was used multiple times\n\tat androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider(SaveableStateHolder.kt:88)`,
  };
  assert.deepEqual(decide({ exception, anchor: messageAnchor, diff: fixDiff, baseRun: composeCrash, headRun: pass, suiteRun: pass }), { ok: true, result: 'proven' });
});

test('still failing with the fix, or a red suite, is rejected', () => {
  assert.match(decide({ ...base, baseRun: crashed, headRun: crashed, suiteRun: pass }).reason, /still fails/);
  assert.match(decide({ ...base, baseRun: crashed, headRun: pass, suiteRun: { status: 'fail' } }).reason, /suite/);
});

test('a diff with only tests has no fix in source', () => {
  const r = decide({ ...base, diff: testOnlyDiff, baseRun: crashed, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no fix in source/);
});

test('loosening an existing test, @Ignore, sleeps and retries are rejected', () => {
  const edits = [
    ['diff --git a/a/src/commonTest/kotlin/OldTest.kt b/a/src/commonTest/kotlin/OldTest.kt', '--- a/a/src/commonTest/kotlin/OldTest.kt', '+++ b/a/src/commonTest/kotlin/OldTest.kt', '-        assertEquals(3, count)'],
    ['+++ b/a/src/commonTest/kotlin/NewTest.kt', '+    @Ignore'],
    ['+++ b/a/src/commonTest/kotlin/NewTest.kt', '+        Thread.sleep(2000)'],
    ['+++ b/functions/test/x.test.ts', "+  it('works', { retry: 3 }, () => {})"],
  ];
  for (const lines of edits) {
    const r = decide({ ...base, diff: `${fixDiff}\n${lines.join('\n')}`, baseRun: crashed, headRun: pass, suiteRun: pass });
    assert.equal(r.ok, false, lines.at(-1));
  }
});

test('diffFacts lists new and changed test files and source files', () => {
  assert.deepEqual(diffFacts(fixDiff), {
    testFiles: ['shared/data/src/commonTest/kotlin/com/x/ParserTest.kt'],
    declaredTests: [],
    sourceFiles: ['shared/data/src/commonMain/kotlin/com/x/Parser.kt'],
    problems: [],
  });
});

test('JUnit XML gives the failure type and stack of the matching test', () => {
  const xml = `<?xml version="1.0"?><testsuite><testcase name="a crash input parses" classname="com.x.ParserTest" time="0.1">
<failure message="bad" type="java.lang.IllegalArgumentException">java.lang.IllegalArgumentException: bad
\tat com.x.Parser.parse(Parser.kt:12)</failure></testcase><testcase name="other" classname="com.x.ParserTest"/></testsuite>`;
  assert.deepEqual(parseJUnit([xml]), {
    status: 'fail',
    failureType: 'java.lang.IllegalArgumentException',
    stack: 'java.lang.IllegalArgumentException: bad\n\tat com.x.Parser.parse(Parser.kt:12)',
    ran: ['com.x.ParserTest'],
  });
  assert.deepEqual(parseJUnit(['<testsuite><testcase name="a" classname="b"/></testsuite>']), { status: 'pass', ran: ['b'] });
  assert.deepEqual(parseJUnit([]), { status: 'error' });
});

test('vitest JSON gives the error name and stack', () => {
  const json = JSON.stringify({ testResults: [{ name: '/w/functions/test/parse.test.ts', assertionResults: [
    { status: 'failed', failureMessages: ['TypeError: Cannot read properties of undefined\n    at parse (src/parse.ts:3:9)'] },
  ] }] });
  assert.deepEqual(parseVitest(json), {
    status: 'fail',
    failureType: 'TypeError',
    stack: 'TypeError: Cannot read properties of undefined\n    at parse (src/parse.ts:3:9)',
    ran: ['/w/functions/test/parse.test.ts'],
  });
  assert.deepEqual(parseVitest(JSON.stringify({ testResults: [{ name: 'a.test.ts', assertionResults: [{ status: 'passed' }] }] })), { status: 'pass', ran: ['a.test.ts'] });
  assert.deepEqual(parseVitest(JSON.stringify({ testResults: [] })), { status: 'error' });
});

// Found by the end-of-build review, 2026-10-28.

test('a message anchor is only matched in the message, not in a test frame', () => {
  const libraryThrow = {
    status: 'fail',
    failureType: exception,
    stack: 'java.lang.IllegalArgumentException: Invalid UUID string: x\n\tat java.util.UUID.fromString(UUID.java:1)\n\t' +
      `at ${messageAnchor.text}Test.crashes(HomeTabTest.kt:5)`,
  };
  const r = decide({ exception, anchor: messageAnchor, diff: fixDiff, baseRun: libraryThrow, headRun: pass, suiteRun: pass });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never reached app code/);
});

test('a frame anchor is only matched in a frame, not in the message', () => {
  const inMessage = { ...crashed, stack: `java.lang.IllegalArgumentException: ${frameAnchor.text} said no\n\tat kotlin.text.StringsKt.toInt(Strings.kt:1)` };
  assert.equal(decide({ ...base, baseRun: inMessage, headRun: pass, suiteRun: pass }).ok, false);
});

test('a throw from an unchanged test helper counts as the test itself', () => {
  const fromHelper = { ...crashed, stack: 'java.lang.IllegalArgumentException: bad\n\tat com.x.Fakes.boom(TestFakes.kt:3)\n\tat com.example.app.data.Parser.parse(Parser.kt:12)' };
  const r = decide({ ...base, baseRun: fromHelper, headRun: pass, suiteRun: pass, knownTestFiles: ['shared/data/src/commonTest/kotlin/com/x/TestFakes.kt'] });
  assert.match(r.reason, /thrown by the test itself/);
});

test('a vitest frame thrown from the test file counts as the test itself', () => {
  const diff = fixDiff.replaceAll('shared/data/src/commonTest/kotlin/com/x/ParserTest.kt', 'functions/test/parse.test.ts');
  const run = { status: 'fail', failureType: 'TypeError', stack: 'TypeError: boom\n    at /w/functions/test/parse.test.ts:4:11' };
  const r = decide({ exception: 'TypeError', anchor: { kind: 'frame', text: 'parse' }, diff, baseRun: run, headRun: pass, suiteRun: pass });
  assert.match(r.reason, /thrown by the test itself/);
});

test('deleting or moving a test file, qualified @Ignore, assumptions and build edits are rejected', () => {
  const edits = [
    ['diff --git a/a/src/commonTest/kotlin/ATest.kt b/a/src/commonTest/kotlin/ATest.kt', 'deleted file mode 100644', '--- a/a/src/commonTest/kotlin/ATest.kt', '+++ /dev/null', '-class ATest'],
    ['+++ b/a/src/commonTest/kotlin/NewTest.kt', '+    @kotlin.test.Ignore'],
    ['+++ b/a/src/commonTest/kotlin/NewTest.kt', '+    @org.junit.Ignore'],
    ['+++ b/a/src/commonTest/kotlin/NewTest.kt', '+        assumeTrue(false)'],
    ['--- a/shared/data/build.gradle.kts', '+++ b/shared/data/build.gradle.kts', '+    filter { excludeTestsMatching("*Old*") }'],
    ['--- a/.claude/skills/crash-fix/lib/proof.mjs', '+++ b/.claude/skills/crash-fix/lib/proof.mjs', '+  return { ok: true }'],
  ];
  for (const lines of edits) {
    const r = decide({ ...base, diff: `${fixDiff}\n${lines.join('\n')}`, baseRun: crashed, headRun: pass, suiteRun: pass });
    assert.equal(r.ok, false, lines.at(-1));
  }
});

test("a filter that does not run the branch's new test is rejected", () => {
  const r = decide({ ...base, baseRun: { ...crashed, ran: ['com.x.SomeOtherTest'] }, headRun: pass, suiteRun: pass });
  assert.match(r.reason, /does not run the branch's new test/);
  assert.equal(decide({ ...base, baseRun: { ...crashed, ran: ['com.x.ParserTest'] }, headRun: pass, suiteRun: pass }).ok, true);
});

// iOS: a Swift package's fix and its new test, and the runs the Xcode runner reports.
const swiftDiff = [
  'diff --git a/Sources/Wordbook/Parser.swift b/Sources/Wordbook/Parser.swift',
  '--- a/Sources/Wordbook/Parser.swift',
  '+++ b/Sources/Wordbook/Parser.swift',
  '@@ -1,3 +1,3 @@',
  '-        let value = text!',
  '+        guard let value = text else { return 0 }',
  'diff --git a/Tests/WordbookTests/ParserTests.swift b/Tests/WordbookTests/ParserTests.swift',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/Tests/WordbookTests/ParserTests.swift',
  '@@ -0,0 +1,3 @@',
  '+    func testCountOfNil() { XCTAssertEqual(Parser.count(of: nil), 0) }',
].join('\n');
const trap = (...frames) => ({
  status: 'fail',
  failureType: 'EXC_BREAKPOINT',
  signal: 'SIGTRAP',
  message: 'Fatal error: Unexpectedly found nil while unwrapping an Optional value',
  frames: [{ symbol: '_assertionFailure(_:_:file:line:flags:)', file: null }, ...frames],
  stack: 'EXC_BREAKPOINT (SIGTRAP): Fatal error: Unexpectedly found nil while unwrapping an Optional value',
  ran: ['ParserTests'],
});
const appFrame = { symbol: 'static Parser.count(of:)', file: 'Parser.swift' };
const testFrame = { symbol: 'ParserTests.testCountOfNil()', file: 'ParserTests.swift' };
const swift = { exception: 'EXC_BREAKPOINT', anchor: { kind: 'frame', text: 'specialized static Parser.count(of:)' }, diff: swiftDiff };

test("a Swift trap in app code, anchored on the release build's specialized frame: proven", () => {
  assert.deepEqual(decide({ ...swift, baseRun: trap(appFrame, testFrame), headRun: pass, suiteRun: pass }), { ok: true, result: 'proven' });
  assert.equal(decide({ ...swift, exception: 'SIGTRAP', baseRun: trap(appFrame, testFrame), headRun: pass, suiteRun: pass }).ok, true);
  const closure = { symbol: 'closure #1 in static Parser.count(of:)', file: 'Parser.swift' };
  assert.equal(decide({ ...swift, baseRun: trap(closure, appFrame, testFrame), headRun: pass, suiteRun: pass }).ok, true);
});

test('a Swift trap in the test itself, or another exception, is not the crash', () => {
  const own = decide({ ...swift, baseRun: trap(testFrame), headRun: pass, suiteRun: pass });
  assert.match(own.reason, /thrown by the test itself \(ParserTests.swift\)/);
  const other = decide({ ...swift, exception: 'EXC_BAD_ACCESS', baseRun: trap(appFrame, testFrame), headRun: pass, suiteRun: pass });
  assert.match(other.reason, /not the crash's EXC_BAD_ACCESS/);
  const elsewhere = decide({ ...swift, baseRun: trap({ symbol: 'static Parser.first(of:)', file: 'Parser.swift' }, testFrame), headRun: pass, suiteRun: pass });
  assert.match(elsewhere.reason, /never reached app code/);
});

test('XCTSkip, expected failures, Swift sleeps and Xcode project edits are rejected; adding to a test file is not', () => {
  const addTo = (line) => swiftDiff.replace('+    func testCountOfNil()', `${line}\n+    func testCountOfNil()`);
  assert.match(decide({ ...swift, diff: addTo('+        throw XCTSkip("later")'), baseRun: trap(appFrame, testFrame) }).reason, /skips a test/);
  assert.match(decide({ ...swift, diff: addTo('+        withKnownIssue { }'), baseRun: trap(appFrame, testFrame) }).reason, /expects the failure/);
  assert.match(decide({ ...swift, diff: addTo('+        try await Task.sleep(for: .seconds(1))'), baseRun: trap(appFrame, testFrame) }).reason, /sleeps/);
  assert.match(decide({ ...swift, diff: addTo('+    @Test(.disabled("flaky")) func b() {}'), baseRun: trap(appFrame, testFrame) }).reason, /switches a test off/);
  const project = `${swiftDiff}\ndiff --git a/App.xcodeproj/project.pbxproj b/App.xcodeproj/project.pbxproj\n--- a/App.xcodeproj/project.pbxproj\n+++ b/App.xcodeproj/project.pbxproj\n+\t\tA1 /* ParserTests.swift */,`;
  assert.match(decide({ ...swift, diff: project, baseRun: trap(appFrame, testFrame) }).reason, /project\.pbxproj/);
  const appended = swiftDiff.replace('new file mode 100644\n--- /dev/null', '--- a/Tests/WordbookTests/ParserTests.swift');
  assert.deepEqual(diffFacts(appended).testFiles, ['Tests/WordbookTests/ParserTests.swift']);
  assert.equal(decide({ ...swift, diff: appended, baseRun: trap(appFrame, testFrame), headRun: pass, suiteRun: pass }).ok, true);
});

test('a test class added to an existing test file counts as the branch\'s test (an Xcode project lists its files)', () => {
  const added = swiftDiff
    .replace('new file mode 100644\n--- /dev/null', '--- a/Tests/WordbookTests/ParserTests.swift')
    .replace('+    func testCountOfNil()', '+final class CartCrashTests: XCTestCase {\n+    func testCountOfNil()');
  assert.deepEqual(diffFacts(added).declaredTests, ['CartCrashTests', 'testCountOfNil']);
  const run = { ...trap(appFrame, { symbol: 'CartCrashTests.testCountOfNil()', file: 'ParserTests.swift' }), ran: ['CartCrashTests'] };
  assert.equal(decide({ ...swift, diff: added, baseRun: run, headRun: pass, suiteRun: pass }).ok, true);
  assert.match(decide({ ...swift, diff: added, baseRun: { ...run, ran: ['OtherTests'] } }).reason, /does not run the branch's new test/);
});

test('paths as git writes them: a tab after a space, quotes around a quote', () => {
  const spaced = [
    'diff --git a/iOS/Toast Catalog/Items.swift b/iOS/Toast Catalog/Items.swift',
    '--- a/iOS/Toast Catalog/Items.swift\t',
    '+++ b/iOS/Toast Catalog/Items.swift\t',
    '+        let x = 1',
    'diff --git "a/iOS/Toast CatalogTests/A\\"Tests.swift" "b/iOS/Toast CatalogTests/A\\"Tests.swift"',
    '--- "a/iOS/Toast CatalogTests/A\\"Tests.swift"',
    '+++ "b/iOS/Toast CatalogTests/A\\"Tests.swift"',
    '+    func testA() {}',
  ].join('\n');
  const facts = diffFacts(spaced);
  assert.deepEqual(facts.sourceFiles, ['iOS/Toast Catalog/Items.swift']);
  assert.deepEqual(facts.testFiles, ['iOS/Toast CatalogTests/A"Tests.swift']);
});

test('an exception XCTest caught has no files: own frames decide app code or the test', () => {
  const caught = (...frames) => ({
    status: 'fail', failureType: 'NSInternalInconsistencyException', signal: null, message: 'Fatal: supplied item identifiers are not unique.',
    frames: [{ symbol: '__exceptionPreprocess', file: null, own: false }, { symbol: '-[__UIDiffableDataSourceSnapshot appendItemsWithIdentifiers:]', file: null, own: false }, ...frames],
    stack: 'NSInternalInconsistencyException: Fatal: supplied item identifiers are not unique.', ran: ['ParserTests'],
  });
  const ui = { ...swift, exception: 'NSInternalInconsistencyException', anchor: { kind: 'frame', text: 'ItemsViewController.update(with:animate:)' } };
  const app = { symbol: 'ItemsViewController.update(with:animate:)', file: null, own: true };
  const inTest = { symbol: 'ParserTests.testCountOfNil()', file: null, own: true };
  assert.equal(decide({ ...ui, baseRun: caught(app, inTest), headRun: pass, suiteRun: pass }).ok, true);
  assert.match(decide({ ...ui, baseRun: caught(inTest) }).reason, /thrown by the test itself \(ParserTests.testCountOfNil\(\)\)/);
  const helper = { symbol: 'closure #1 in static NetworkClientTests.makeItems()', file: null, own: true };
  assert.match(decide({ ...ui, baseRun: caught(helper, app, inTest), knownTestFiles: ['Tests/WordbookTests/NetworkClientTests.swift'] }).reason, /thrown by the test itself/);
});

test('Swift Testing: a free @Test function is the branch\'s test, and a crash it throws itself is not the crash', () => {
  const freeDiff = swiftDiff.replace('+    func testCountOfNil() { XCTAssertEqual(Parser.count(of: nil), 0) }', '+@Test func countOfNilIsZero() { #expect(Parser.count(of: nil) == 0) }');
  const ownFrame = { symbol: 'countOfNilIsZero()', file: 'ParserTests.swift' };
  const run = { ...trap(appFrame, ownFrame), ran: ['countOfNilIsZero'] };
  assert.equal(decide({ ...swift, diff: freeDiff, baseRun: run, headRun: pass, suiteRun: pass }).ok, true);
  assert.match(decide({ ...swift, diff: freeDiff, baseRun: { ...trap(ownFrame), ran: ['countOfNilIsZero'] } }).reason, /thrown by the test itself/);
});
