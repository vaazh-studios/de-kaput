import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appFor, loadConfig, moduleFor, moduleForAnyApp, parseConfig } from '../src/config.mjs';
import { tempDir } from './tmp.mjs';

const GOOD = `
version: 1
open-pull-requests-limit: 3
reviewers: [octocat]
apps:
  - name: android
    platform: android
    crashlytics-app-id: "1:123:android:abc"
    packages: [com.example.app]
    ignore-frames: [com.example.app.crashreporting]
    probes: ["crash-reporting canary"]
    release-tags: ["release/{version}-{build}"]
    modules:
      - path: shared/presentation
        gradle-task: ":shared:presentation:testAndroidHostTest"
      - path: shared
        gradle-task: ":shared:testAndroidHostTest"
      - path: app
        gradle-task: ":app:testDebugUnitTest"
  - name: ios
    platform: ios
    crashlytics-app-id: "1:123:ios:def"
    modules:
      - path: ios
        xcode-scheme: App
        xcode-workspace: App.xcworkspace
`;

const dir = () => tempDir('dekaput-config-');

test('a full config reads back with its values', () => {
  const config = parseConfig(GOOD);
  assert.equal(config.openPullRequestsLimit, 3);
  assert.deepEqual(config.reviewers, ['octocat']);
  assert.equal(config.apps[0].crashlyticsAppId, '1:123:android:abc');
  assert.deepEqual(config.apps[0].releaseTags, ['release/{version}-{build}']);
});

test('defaults: a PR limit of 5, the standard release tags, no reviewers', () => {
  const config = parseConfig('version: 1\napps:\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n    packages: [com.example.app]\n');
  assert.equal(config.openPullRequestsLimit, 5);
  assert.deepEqual(config.reviewers, []);
  assert.deepEqual(config.apps[0].releaseTags, ['{platform}/v{version}-{build}', 'v{version}-{build}']);
  assert.deepEqual(config.apps[0].probes, []);
});

test('mistakes are named, not guessed', () => {
  assert.throws(() => parseConfig('version: 1\n'), /apps/);
  assert.throws(() => parseConfig('version: 2\napps: []\n'), /version 1/);
  assert.throws(() => parseConfig(`${GOOD}\nopen-pr-limit: 2\n`), /unknown key "open-pr-limit"/);
  assert.throws(() => parseConfig('version: 1\napps:\n  - platform: windows\n    crashlytics-app-id: x\n    packages: [a]\n'), /platform/);
  assert.throws(() => parseConfig('version: 1\napps:\n  - platform: ios\n    packages: [a]\n'), /crashlytics-app-id/);
  assert.throws(() => parseConfig('version: 1\napps:\n  - platform: android\n    crashlytics-app-id: x\n'), /packages/);
  assert.throws(() => parseConfig('version: 1\napps:\n  - platform: ios\n    crashlytics-app-id: x\n    packages: [a]\n    module: []\n'), /unknown key "module"/);
});

test('.github/de-kaput.yml is found first, de-kaput.yml at the root otherwise, nothing is null', () => {
  const root = dir();
  assert.equal(loadConfig(root), null);
  fs.writeFileSync(path.join(root, 'de-kaput.yml'), GOOD.replace('open-pull-requests-limit: 3', 'open-pull-requests-limit: 4'));
  assert.equal(loadConfig(root).openPullRequestsLimit, 4);
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github', 'de-kaput.yml'), GOOD);
  assert.equal(loadConfig(root).openPullRequestsLimit, 3);
});

test("a crash's app is the one for its platform, or the one named", () => {
  const config = parseConfig(GOOD);
  assert.equal(appFor(config, 'ANDROID').name, 'android');
  assert.equal(appFor(config, 'IOS').name, 'ios');
  assert.equal(appFor(config, 'IOS', 'android').name, 'android');
  assert.throws(() => appFor(config, 'IOS', 'web'), /no app named "web"/);
});

test("the Gradle task comes from the module that holds the branch's tests, the most specific path first", () => {
  const app = parseConfig(GOOD).apps[0];
  assert.equal(moduleFor(app, ['shared/presentation/src/androidHostTest/kotlin/a/ATest.kt']).gradleTask, ':shared:presentation:testAndroidHostTest');
  assert.equal(moduleFor(app, ['shared/src/commonTest/kotlin/a/BTest.kt']).gradleTask, ':shared:testAndroidHostTest');
  assert.equal(moduleFor(app, ['docs/x.md']), null);
  assert.throws(() => moduleFor(app, ['app/src/test/kotlin/ATest.kt', 'shared/presentation/src/androidHostTest/kotlin/BTest.kt']), /two modules/);
});

test('the module is looked up across every app: a Gradle task or an Xcode scheme', () => {
  const config = parseConfig(GOOD);
  assert.equal(moduleForAnyApp(config, ['app/src/test/kotlin/ATest.kt']).gradleTask, ':app:testDebugUnitTest');
  assert.deepEqual(moduleForAnyApp(config, ['ios/AppTests/ParserTests.swift']).xcode, { scheme: 'App', workspace: 'App.xcworkspace', project: null, destination: null, args: [] });
  assert.equal(moduleForAnyApp(config, ['web/x.test.ts']), null);
});

test('an Xcode module at the repo root holds every file; its keys are checked', () => {
  const ios = (module) => parseConfig(`version: 1\napps:\n  - platform: ios\n    crashlytics-app-id: x\n    modules:\n      - path: "."\n${module}`).apps[0];
  const root = ios('        xcode-scheme: Wordbook\n');
  assert.equal(root.modules[0].path, '');
  assert.deepEqual(root.packages, []);
  assert.equal(moduleFor(root, ['Tests/WordbookTests/ParserTests.swift']).xcode.scheme, 'Wordbook');
  assert.throws(() => ios('        xcode-project: A.xcodeproj\n'), /"gradle-task" \(Gradle\) or "xcode-scheme"/);
  assert.throws(() => ios('        xcode-scheme: A\n        gradle-task: ":a:test"\n'), /one of the two/);
  assert.throws(() => ios('        xcode-scheme: A\n        xcode-project: A.xcodeproj\n        xcode-workspace: A.xcworkspace\n'), /not both/);
  assert.deepEqual(ios('        xcode-scheme: A\n        xcode-args: ["CODE_SIGNING_ALLOWED=NO", "-testPlan", "CI"]\n').modules[0].xcode.args, ['CODE_SIGNING_ALLOWED=NO', '-testPlan', 'CI']);
  assert.throws(() => ios('        xcode-scheme: A\n        xcode-args: CODE_SIGNING_ALLOWED=NO\n'), /"xcode-args" must be a list of strings/);
});

test('releases: unset is null (the agent asks); one release or a list reads back as a list', () => {
  const app = (releases) => parseConfig(`version: 1\napps:\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n${releases}`).apps[0].releases;
  assert.equal(app(''), null);
  assert.deepEqual(app('    releases: latest\n'), ['latest']);
  assert.deepEqual(app('    releases: ["ios/v1.4-77", "1.4 (75)"]\n'), ['ios/v1.4-77', '1.4 (75)']);
  assert.throws(() => app('    releases: []\n'), /"releases" must not be empty/);
  assert.throws(() => app('    releases: 77\n'), /"releases" must be a list of strings/);
});
