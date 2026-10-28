import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  caughtFailure, crashFailure, crashReportFor, fatalMessage, ownImages, parseCaughtException, parseCrashLog, parseTestResults, pickDestination, uncaughtIn,
} from '../src/runners/xcode.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const testCase = (name, result, ...messages) => ({
  name: `${name}()`,
  nodeIdentifier: `WordbookTests/${name}()`,
  nodeType: 'Test Case',
  result,
  children: messages.map((m) => ({ name: m, nodeType: 'Failure Message' })),
});
const tree = (...cases) => ({
  testNodes: [{
    name: 'Wordbook',
    nodeType: 'Test Plan',
    children: [{ name: 'WordbookTests', nodeType: 'Unit test bundle', children: [{ name: 'WordbookTests', nodeType: 'Test Suite', children: cases }] }],
  }],
});

test('the result bundle names the classes that ran and the first test that failed', () => {
  const { ran, failed } = parseTestResults(tree(
    testCase('testPasses', 'Passed'),
    testCase('testCountOfNil', 'Failed', 'Crash: xctest at static xctest.main()'),
    testCase('testRaise', 'Failed', 'planted (NSInvalidArgumentException)'),
  ));
  assert.deepEqual(ran, ['WordbookTests']);
  assert.deepEqual(failed, { id: 'WordbookTests/testCountOfNil()', name: 'testCountOfNil()', messages: ['Crash: xctest at static xctest.main()'] });
});

test('skipped tests did not run', () => {
  assert.deepEqual(parseTestResults(tree(testCase('testSkipped', 'Skipped'))), { ran: [], failed: null });
});

test('a Swift trap: EXC_BREAKPOINT and SIGTRAP, the frames with their files', () => {
  const crash = parseCrashLog(fixture('ios-swift-trap.ips'));
  assert.equal(crash.type, 'EXC_BREAKPOINT');
  assert.equal(crash.signal, 'SIGTRAP');
  assert.deepEqual(crash.frames[2], { symbol: 'static Parser.count(of:)', file: 'Parser.swift', line: 5, image: 'WordbookTests' });
  assert.equal(crash.frames[0].file, null);
});

test('an uncaught NSException: its name, reason and throw stack', () => {
  const report = {
    exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
    asi: { CoreFoundation: ["*** Terminating app due to uncaught exception 'NSRangeException', reason: '*** index 3 beyond bounds [0 .. 1]'"] },
    lastExceptionBacktrace: [{ imageIndex: 0, symbol: '__exceptionPreprocess' }, { imageIndex: 1, symbol: 'Cart.item(at:)', sourceFile: 'Cart.swift', sourceLine: 9 }],
    faultingThread: 0,
    threads: [{ frames: [{ imageIndex: 0, symbol: '__pthread_kill' }] }],
    usedImages: [{ name: 'CoreFoundation' }, { name: 'Shop' }],
  };
  const crash = parseCrashLog(`{"app_name":"Shop"}\n${JSON.stringify(report)}`);
  assert.equal(crash.type, 'NSRangeException');
  assert.equal(crash.signal, 'SIGABRT');
  assert.equal(crash.message, '*** index 3 beyond bounds [0 .. 1]');
  assert.deepEqual(crash.frames.map((f) => f.symbol), ['__exceptionPreprocess', 'Cart.item(at:)']);
});

test("a crash's stack starts at the first frame with a file and carries the Swift message", () => {
  const failure = crashFailure(parseCrashLog(fixture('ios-swift-trap.ips')), 'Fatal error: Unexpectedly found nil while unwrapping an Optional value');
  assert.equal(failure.failureType, 'EXC_BREAKPOINT');
  assert.equal(failure.stack.split('\n').slice(0, 2).join('\n'),
    'EXC_BREAKPOINT (SIGTRAP): Fatal error: Unexpectedly found nil while unwrapping an Optional value\n\tat static Parser.count(of:) (Parser.swift:5)');
});

test('an exception XCTest caught: its name, reason and the demangled stack', () => {
  const names = { $s8Wordbook6ParserO5raiseyyFZ: 'static Parser.raise()', $s13WordbookTestsAAC9testRaiseyyF: 'WordbookTests.testRaise()' };
  const caught = parseCaughtException(fixture('ios-caught-exception.txt'), (symbols) => symbols.map((s) => names[s] ?? s));
  assert.equal(caught.type, 'NSInvalidArgumentException');
  assert.equal(caught.message, 'planted');
  assert.deepEqual(caught.frames[3], { symbol: 'static Parser.raise()', file: null, line: null, image: 'WordbookTests' });
});

test('in an app-hosted test, image names hold spaces and the stack starts at the first frame of own code', () => {
  const report = [
    'failed: caught "NSInternalInconsistencyException", "Fatal: supplied item identifiers are not unique."',
    '(',
    '\t0   CoreFoundation                      0x00000001c0287f24 __exceptionPreprocess + 172',
    '\t3   CollectionViewCore                  0x000000024baea9a0 -[_UIDiffableDataSourceUpdate initWithIdentifiers:] + 512',
    '\t7   Shop App.debug.dylib                0x0000000102eee390 $sCartUpdate + 304',
    '\t8   Shop AppTests                       0x0000000103b0637c $sCartCrashTest + 376',
    ')',
  ].join('\n');
  const names = { $sCartUpdate: 'CartViewController.update(with:animate:)', $sCartCrashTest: 'CartCrashTests.testSameItemTwice()' };
  const caught = parseCaughtException(report, (symbols) => symbols.map((s) => names[s] ?? s));
  assert.deepEqual(caught.frames.map((f) => f.image), ['CoreFoundation', 'CollectionViewCore', 'Shop App.debug.dylib', 'Shop AppTests']);
  const own = new Set(['Shop App', 'Shop App.debug.dylib', 'Shop AppTests']);
  const failure = caughtFailure({ ...caught, frames: caught.frames.map((f) => ({ ...f, own: own.has(f.image) })) });
  assert.equal(failure.stack.split('\n').slice(1).join('\n'), '\tat CartViewController.update(with:animate:)\n\tat CartCrashTests.testSameItemTwice()');
});

test("own images are the build's products: bundles by name, dylibs by file", () => {
  const products = fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-products-'));
  const app = path.join(products, 'Debug-iphonesimulator', 'Shop App.app');
  fs.mkdirSync(path.join(app, 'PlugIns', 'Shop AppTests.xctest'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Frameworks', 'ShopKit.framework'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Shop App.debug.dylib'), '');
  fs.mkdirSync(path.join(products, 'Debug-iphonesimulator', 'Shop.swiftmodule'));
  assert.deepEqual([...ownImages(products)].sort(), ['Shop App', 'Shop App.debug.dylib', 'Shop AppTests', 'ShopKit']);
  assert.deepEqual([...ownImages(path.join(products, 'missing'))], []);
});

test('the Swift message comes from the test run output', () => {
  const output = [
    "Test Case '-[WordbookTests.WordbookTests testPasses]' started.",
    "Test Case '-[WordbookTests.WordbookTests testCountOfNil]' started.",
    'Wordbook/Parser.swift:5: Fatal error: Unexpectedly found nil while unwrapping an Optional value',
    '/Users/me/my apps/Wordbook/Sources/Wordbook/Parser.swift:14: error: -[WordbookTests.WordbookTests testRaise] : planted (NSInvalidArgumentException)',
  ].join('\n');
  assert.equal(fatalMessage(output, 'testCountOfNil()'), 'Fatal error: Unexpectedly found nil while unwrapping an Optional value');
  assert.equal(fatalMessage('nothing here', 'testCountOfNil()'), '');
});

test('the simulator is an iPhone on the newest iOS', () => {
  const devices = {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'A' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ name: 'iPad Pro', udid: 'B' }, { name: 'iPhone 18 Pro', udid: 'C' }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ name: 'Apple Watch', udid: 'D' }],
  };
  assert.equal(pickDestination(devices), 'platform=iOS Simulator,id=C');
  assert.throws(() => pickDestination({}), /no iPhone simulator/);
});

test("without an attached crash log, the crash reporter's report of the test is used: recent and naming the test", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-reports-'));
  const [header, body] = [fixture('ios-swift-trap.ips').split('\n')[0], JSON.parse(fixture('ios-swift-trap.ips').split('\n').slice(1).join('\n'))];
  const write = (name, report, age = 0) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${header}\n${JSON.stringify(report)}`);
    const at = new Date(Date.now() - age);
    fs.utimesSync(file, at, at);
  };
  const since = Date.now() - 60_000;
  write('other-app.ips', { ...body, threads: [{ frames: [{ imageIndex: 0, symbol: 'main' }] }] });
  write('old.ips', { ...body, parentProc: 'launchd_sim' }, 120_000);
  assert.equal(crashReportFor('testCountOfNilDoesNotCrash()', since, dir), null);
  write('xctest.ips', { ...body, parentProc: 'launchd_sim' });
  assert.equal(parseCrashLog(crashReportFor('testCountOfNilDoesNotCrash()', since, dir)).frames[2].symbol, 'static Parser.count(of:)');
  assert.equal(crashReportFor('testOther()', since, dir), null);
  assert.equal(crashReportFor('testCountOfNilDoesNotCrash()', since, path.join(dir, 'missing')), null);
});

test('Swift Testing: a function outside any suite ran by its own name', () => {
  const free = { name: 'firstOfEmpty()', nodeIdentifier: 'firstOfEmpty()', nodeType: 'Test Case', result: 'Failed', children: [{ name: 'Crash: xctest at static Runner.run()', nodeType: 'Failure Message' }] };
  const { ran, failed } = parseTestResults({ testNodes: [{ nodeType: 'Test Plan', children: [{ nodeType: 'Unit test bundle', name: 'WordbookTests', children: [free] }] }] });
  assert.deepEqual(ran, ['firstOfEmpty']);
  assert.equal(failed.id, 'firstOfEmpty()');
});

test("an uncaught NSException in a simulator: the throw stack from the crash log, its name from the run's output", () => {
  const report = {
    exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
    lastExceptionBacktrace: [{ imageIndex: 0, symbol: '__exceptionPreprocess' }, { imageIndex: 1, symbol: 'static Parser.raise()', sourceFile: 'Parser.swift', sourceLine: 14 }],
    faultingThread: 0,
    threads: [{ frames: [{ imageIndex: 0, symbol: '__pthread_kill' }] }],
    usedImages: [{ name: 'CoreFoundation' }, { name: 'WordbookTests' }],
  };
  const crash = parseCrashLog(`{"app_name":"xctest"}\n${JSON.stringify(report)}`);
  assert.equal(crash.type, 'EXC_CRASH');
  assert.equal(crash.thrown, true);
  assert.deepEqual(crash.frames.map((f) => f.symbol), ['__exceptionPreprocess', 'static Parser.raise()']);
  const output = '◇ Test raises() started.\n✘ Test raises() recorded an issue: Issue recorded\n  failed: caught "NSInvalidArgumentException", "planted"\n';
  assert.deepEqual(uncaughtIn(output, 'raises()'), { type: 'NSInvalidArgumentException', message: 'planted' });
  assert.deepEqual(uncaughtIn("*** Terminating app due to uncaught exception 'NSRangeException', reason: 'index 3 beyond bounds'", 'testA()'), { type: 'NSRangeException', message: 'index 3 beyond bounds' });
  const failure = crashFailure({ ...crash, ...uncaughtIn(output, 'raises()') });
  assert.equal(failure.stack.split('\n').slice(0, 2).join('\n'), 'NSInvalidArgumentException (SIGABRT): planted\n\tat static Parser.raise() (Parser.swift:14)');
});
