import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyIssue, nativeFileFinder, parseFrames, sourceSetFinder, stableText } from '../src/classify.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Stands in for the repo lookup: every file the fixtures name lives in commonMain.
const inCommonMain = () => 'commonMain';
// What an app passes in: its own packages, its crash reporter, its deliberate probes.
const opts = {
  appPackages: ['com.example.app', 'com.example.lib'],
  ignoreFrames: ['com.example.app.crashreporting'],
  probes: [/crash-reporting canary/i, /\bhook probe\b/i],
};

test('the three out-of-memory crashes get a note', () => {
  for (const name of ['android-oom-kitatlas.json', 'android-oom-palettemesh.json', 'android-oom-floatbuilder.json']) {
    const result = classifyIssue(fixture(name), inCommonMain, opts);
    assert.equal(result.stop, 'note', name);
    assert.match(result.reason, /OutOfMemoryError/);
  }
});

test('a Kotlin/Native abort gets a note asking for the Kotlin exception', () => {
  const result = classifyIssue(fixture('ios-konan-abort.json'), inCommonMain, opts);
  assert.equal(result.stop, 'note');
  assert.match(result.reason, /Kotlin exception/);
});

test('the currentTab crash is attempted, anchored on the class its message names', () => {
  const result = classifyIssue(fixture('android-currenttab.json'), inCommonMain, opts);
  assert.equal(result.stop, 'attempt');
  assert.equal(result.exception, 'java.lang.IllegalArgumentException');
  assert.deepEqual(result.anchor, {
    kind: 'message',
    text: 'com.example.app.ui.tabs.HomeTab',
    sourceSet: 'commonMain',
  });
});

test('an in-app frame wins over a class named in the message', () => {
  const event = {
    ...fixture('android-currenttab.json'),
    exceptions: 'java.lang.IllegalStateException: com.example.lib.Foo broke\nat com.example.app.data.Bar.run (Bar.kt:12)\nat android.os.Looper.loop (Looper.java:1)',
  };
  const result = classifyIssue(event, inCommonMain, opts);
  assert.equal(result.stop, 'attempt');
  assert.deepEqual(result.anchor, { kind: 'frame', text: 'com.example.app.data.Bar.run', sourceSet: 'commonMain' });
});

test('an in-app frame only in iosMain gets a note', () => {
  const event = { ...fixture('android-currenttab.json'), exceptions: 'kotlin.IllegalStateException: x\nat com.example.app.data.Ios.run (Ios.kt:3)' };
  const result = classifyIssue(event, () => 'iosMain', opts);
  assert.equal(result.stop, 'note');
  assert.match(result.reason, /iosMain/);
});

test('a frame the repo does not have gets a note', () => {
  const event = { ...fixture('android-currenttab.json'), exceptions: 'kotlin.IllegalStateException: x\nat com.example.app.data.Gone.run (Gone.kt:3)' };
  assert.equal(classifyIssue(event, () => null, opts).stop, 'note');
});

test('system and library frames only, with no app class in the message, are skipped', () => {
  const event = { ...fixture('android-currenttab.json'), exceptions: 'java.lang.IllegalStateException: no\nat android.os.Looper.loop (Looper.java:1)' };
  const result = classifyIssue(event, inCommonMain, opts);
  assert.equal(result.stop, 'skip');
  assert.match(result.reason, /system or library/);
});

test('an unsymbolicated event gets a note asking for symbols', () => {
  const event = { ...fixture('ios-konan-abort.json'), threads: 'Thread:  (crashed)\nat 0x0000000102f1a2b4\nat 0x0000000102f19000' };
  const result = classifyIssue(event, inCommonMain, opts);
  assert.equal(result.stop, 'note');
  assert.match(result.reason, /symbols/);
});

test('non-fatals and the crash-reporting probes are never attempted', () => {
  const inApp = { ...fixture('android-currenttab.json'), exceptions: 'java.lang.IllegalStateException: x\nat com.example.app.data.Bar.run (Bar.kt:3)' };
  assert.equal(classifyIssue({ ...inApp, errorType: 'NON_FATAL' }, inCommonMain, opts).stop, 'skip');
  const canary = { ...inApp, subtitle: 'si0 - crash-reporting canary (build 75) — expected, not a bug' };
  assert.match(classifyIssue(canary, inCommonMain, opts).reason, /probe/);
  assert.equal(classifyIssue({ ...inApp, subtitle: 'IllegalStateException - hook probe 2026-09-30' }, inCommonMain, opts).stop, 'skip');
});

test('ANRs are skipped', () => {
  assert.equal(classifyIssue({ ...fixture('android-currenttab.json'), errorType: 'ANR' }, inCommonMain, opts).stop, 'skip');
});

test('emulators and simulators are flagged as internal devices', () => {
  assert.equal(classifyIssue(fixture('android-currenttab.json'), inCommonMain, opts).internalDevice, true);
  assert.equal(classifyIssue(fixture('ios-konan-abort.json'), inCommonMain, opts).internalDevice, true);
  assert.equal(classifyIssue({ ...fixture('android-currenttab.json'), device: 'samsung (SM-S918B)' }, inCommonMain, opts).internalDevice, false);
});

test('the source set comes from the file under the class package path', () => {
  const find = sourceSetFinder([
    'shared/presentation/src/commonMain/kotlin/com/example/app/ui/tabs/HomeTab.kt',
    'shared/presentation/src/iosMain/kotlin/com/example/app/crashreporting/FirebaseCrashReporter.ios.kt',
    'shared/data/src/commonMain/kotlin/com/other/HomeTab.kt',
  ]);
  assert.equal(find('HomeTab.kt', 'com.example.app.ui.tabs.HomeTab'), 'commonMain');
  assert.equal(find('Gone.kt', 'com.example.app.Gone'), null);
  assert.equal(find(null, 'com.a.B'), null);
});

test('frames parse from Android and Kotlin/Native lines', () => {
  assert.deepEqual(parseFrames('at com.a.B.c (B.kt:9)\nat kfun:com.a.D.e(){} (D.kt:3)\nat abort'), [
    { symbol: 'com.a.B.c', file: 'B.kt' },
    { symbol: 'com.a.D.e', file: 'D.kt' },
    { symbol: 'abort', file: null },
  ]);
});

test('nothing counts as app code unless the app says so', () => {
  const result = classifyIssue(fixture('android-currenttab.json'), inCommonMain, {});
  assert.equal(result.stop, 'skip');
});

test('a native Android main source set and a java folder are attempted', () => {
  const find = sourceSetFinder(['app/src/main/java/com/example/app/Parser.java']);
  const event = { ...fixture('android-currenttab.json'), exceptions: 'java.lang.IllegalStateException: x\nat com.example.app.Parser.parse (Parser.java:3)' };
  const result = classifyIssue(event, find, opts);
  assert.equal(result.stop, 'attempt');
  assert.equal(result.anchor.sourceSet, 'main');
});

test('the stable text around an R8 name is the anchor when there is no mapping', () => {
  assert.equal(stableText('Key sm8:currentTab was used multiple times '), 'currentTab was used multiple times');
  assert.equal(stableText('no renamed class in here at all'), null);
  assert.equal(stableText('ab1: x'), null);
});

// A native iOS app: Swift sources and tests, no Kotlin packages.
const swiftRepo = nativeFileFinder(['Sources/Wordbook/Parser.swift', 'Sources/Wordbook/WordList.swift', 'Tests/WordbookTests/ParserTests.swift', 'README.md']);

test('a native Swift crash is attempted, anchored on its top frame in a Swift file of the repo', () => {
  const result = classifyIssue(fixture('ios-swift-unwrap.json'), () => null, { nativeFileOf: swiftRepo });
  assert.equal(result.stop, 'attempt');
  assert.equal(result.exception, 'EXC_BREAKPOINT');
  assert.deepEqual(result.anchor, { kind: 'frame', text: 'specialized static Parser.count(of:)', sourceSet: 'Sources/Wordbook/Parser.swift' });
});

test('Swift files in the tests, and files the repo does not have, are not app code', () => {
  assert.equal(swiftRepo('ParserTests.swift'), null);
  assert.equal(swiftRepo('App.swift'), null);
  assert.equal(swiftRepo('Parser.kt'), null);
  const elsewhere = classifyIssue(fixture('ios-swift-unwrap.json'), () => null, { nativeFileOf: () => null });
  assert.equal(elsewhere.stop, 'skip');
});

test('iOS names a crash by its signal; a watchdog kill is skipped', () => {
  const abort = classifyIssue({ ...fixture('ios-swift-unwrap.json'), subtitle: 'SIGABRT (ABORT)' }, () => null, { nativeFileOf: swiftRepo });
  assert.equal(abort.exception, 'SIGABRT');
  const watchdog = classifyIssue({ ...fixture('ios-swift-unwrap.json'), subtitle: 'EXC_CRASH (SIGKILL) 0x8badf00d' }, () => null, { nativeFileOf: swiftRepo });
  assert.equal(watchdog.stop, 'skip');
  assert.match(watchdog.reason, /watchdog/);
});

test('frames parse as Crashlytics writes them and as the JVM does, without eating Swift parentheses', () => {
  assert.deepEqual(parseFrames('at a.B$c$1.invokeSuspend(B.kt:104)\nat a.B.d (B.kt:7)\nat j.N.m(Native Method)'), [
    { symbol: 'a.B$c$1.invokeSuspend', file: 'B.kt' },
    { symbol: 'a.B.d', file: 'B.kt' },
    { symbol: 'j.N.m', file: null },
  ]);
  assert.deepEqual(parseFrames('at static Parser.count(of:)\nat static Parser.count(of:) (Parser.swift:5)'), [
    { symbol: 'static Parser.count(of:)', file: null },
    { symbol: 'static Parser.count(of:)', file: 'Parser.swift' },
  ]);
});
