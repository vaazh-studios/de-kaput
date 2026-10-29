import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.mjs';

const bin = fileURLToPath(new URL('../bin/dekaput.mjs', import.meta.url));
const run = (...args) => spawnSync('node', [bin, ...args], { cwd: '/', encoding: 'utf8' });
const runIn = (cwd, ...args) => spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });

test('runbook prints the RUNBOOK.md that ships with the CLI', () => {
  const printed = execFileSync('node', [bin, 'runbook'], { cwd: '/', encoding: 'utf8' });
  assert.equal(printed, fs.readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8'));
});

test('help is not an error, after a command too', () => {
  for (const args of [[], ['help'], ['--help'], ['-h'], ['list', '--help'], ['verify', '-h']]) {
    const result = run(...args);
    assert.equal(result.status, 0, args.join(' '));
    assert.match(result.stdout, /^usage:/);
  }
});

test('--version prints the package version; an unknown command exits 2', () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(run('--version').stdout.trim(), version);
  assert.equal(run('lsit').status, 2);
});

// A repo with release tags, a config that picks the latest Android release, and two crash events.
function repoWithReleases() {
  const dir = tempDir('dekaput-cli-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, '.github'));
  fs.writeFileSync(path.join(dir, '.github/de-kaput.yml'), 'version: 1\napps:\n  - platform: android\n    crashlytics-app-id: "1:1:android:x"\n    packages: [com.example.app]\n    releases: latest\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  for (const tag of ['android/v1.3-71', 'android/v1.4-75', 'ios/v1.4-77']) git('tag', tag);
  const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  fs.writeFileSync(path.join(dir, 'prs.json'), '[]');
  fs.mkdirSync(path.join(dir, '.dekaput'));
  fs.writeFileSync(path.join(dir, '.dekaput/versions.json'), JSON.stringify({ android: ['1.4 (77)', '1.3 (71)', '1.4 (75)'] }));
  return { dir, events: [fixture('android-currenttab-obfuscated.json'), fixture('android-oom-kitatlas.json')] };
}

test("releases lists Crashlytics' versions newest first with their tags, and latest is the newest tagged one", () => {
  const { dir } = repoWithReleases();
  const [android] = JSON.parse(runIn(dir, 'releases', '--json').stdout);
  assert.deepEqual(android.versions, [{ name: '1.4 (77)', tag: null }, { name: '1.4 (75)', tag: 'android/v1.4-75' }, { name: '1.3 (71)', tag: 'android/v1.3-71' }]);
  assert.equal(android.latest, '1.4 (75)');
  assert.deepEqual(android.selected, ['1.4 (75)']);
});

test('an app with no versions with crashes gets an error; the others are still listed', () => {
  const dir = tempDir('dekaput-cli-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, '.github'));
  fs.writeFileSync(path.join(dir, '.github/de-kaput.yml'), 'version: 1\napps:\n  - platform: android\n    crashlytics-app-id: "1:1:android:x"\n    packages: [com.example.app]\n    releases: latest\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.mkdirSync(path.join(dir, '.dekaput'));
  fs.writeFileSync(path.join(dir, '.dekaput/versions.json'), JSON.stringify({ ios: ['1.4 (77)', '1.4 (76)'] }));
  const listed = runIn(dir, 'releases', '--json');
  assert.equal(listed.status, 0);
  const [android, ios] = JSON.parse(listed.stdout);
  assert.match(android.error, /"latest": no versions with crashes/);
  assert.equal(android.selected, null);
  // No tags at all: latest is simply the newest version with crashes.
  assert.deepEqual(ios.versions, [{ name: '1.4 (77)', tag: null }, { name: '1.4 (76)', tag: null }]);
  assert.equal(ios.latest, '1.4 (77)');
  assert.match(runIn(dir, 'releases').stdout, /android: "latest": no versions with crashes/);
});

test('list keeps only the picked releases; --release wins over the config', () => {
  const { dir, events } = repoWithReleases();
  const listed = (...flags) => JSON.parse(runIn(dir, 'list', '--json', '--prs', 'prs.json', ...flags, ...events).stdout).crashes;
  const skipped = (crashes) => crashes.filter((c) => c.stop === 'skip').map((c) => c.version);
  assert.deepEqual(skipped(listed()), ['1.4 (77)']);
  assert.deepEqual(skipped(listed('--release', '1.4 (77)')), ['1.4 (75)']);
  assert.deepEqual(skipped(listed('--release', 'android/v1.4-75', '--release', '1.4 (77)')), []);
  // An iOS pick leaves the Android crashes to the config's Android pick.
  assert.deepEqual(skipped(listed('--release', 'ios/v1.4-77')), ['1.4 (77)']);
  assert.match(runIn(dir, 'list', '--prs', 'prs.json', '--release', 'android/v9.9-99', ...events).stderr, /neither a release tag/);
});
