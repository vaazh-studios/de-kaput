import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inReleases, latestOf, matchTag, newestFirst, selectReleases, splitVersion } from '../src/versions.mjs';

const tagOf = (platform, tags, opts) => (name) => matchTag(platform, name, tags, opts).tag;

test('a Crashlytics name splits into its version and build; anything else is all version', () => {
  assert.deepEqual(splitVersion('1.4 (75)'), { version: '1.4', build: '75' });
  assert.deepEqual(splitVersion('2.0-beta (1.4.77)'), { version: '2.0-beta', build: '1.4.77' });
  assert.deepEqual(splitVersion('1.4'), { version: '1.4', build: null });
});

test('versions sort newest first, number by number, then by build', () => {
  const names = ['1.9 (90)', '1.10 (80)', '1.10 (81)', '1.4.1 (70)', '1.4 (75)'];
  assert.deepEqual([...names].sort(newestFirst), ['1.10 (81)', '1.10 (80)', '1.9 (90)', '1.4.1 (70)', '1.4 (75)']);
});

test('a tag is found by name, whatever its format', () => {
  for (const tag of ['android/v1.4-75', 'release-1.4-build75', '1.4+75', 'v1.4-75']) {
    assert.equal(matchTag('android', '1.4 (75)', [tag, 'v1.3-71']).tag, tag, tag);
  }
  assert.equal(matchTag('android', '1.4-beta (75)', ['android/v1.4-beta-75']).tag, 'android/v1.4-beta-75');
  assert.equal(matchTag('ios', '1.4 (1.4.77)', ['ios/v1.4-1.4.77']).tag, 'ios/v1.4-1.4.77');
});

test('a value must stand on its own: 1.4 is not 1.4.1 or 11.4, 4 is not 43', () => {
  assert.equal(matchTag('android', '1.4 (75)', ['v1.4.1-75', 'v11.4-75', 'v1.4-175']).tag, null);
  assert.equal(matchTag('ios', '1.0 (4)', ['ios/v1.0-43']).tag, null);
});

test('a tag with only the version covers every build of it; one with only the build names that build', () => {
  assert.equal(matchTag('android', '1.4.0 (75)', ['v1.4.0', 'v1.3.0']).tag, 'v1.4.0');
  assert.equal(matchTag('android', '1.4.0 (76)', ['v1.4.0']).tag, 'v1.4.0');
  assert.equal(matchTag('ios', '1.4 (77)', ['builds/release/77', 'builds/release/76']).tag, 'builds/release/77');
  // Version and build together beat either alone.
  assert.equal(matchTag('ios', '1.4 (77)', ['v1.4', 'builds/release/77', 'ios/v1.4-77']).tag, 'ios/v1.4-77');
});

test("another platform's tag never counts; this platform's wins over a neutral one", () => {
  const tags = ['ios/v1.4-75', 'android/v1.4-75', 'v1.4-75', 'builds/iosbeta/80'];
  assert.equal(matchTag('android', '1.4 (75)', tags).tag, 'android/v1.4-75');
  assert.equal(matchTag('ios', '1.4 (75)', tags).tag, 'ios/v1.4-75');
  assert.equal(matchTag('android', '1.5 (80)', tags).tag, null);
  // "studios" is not iOS: only a word that starts with the platform names it.
  assert.equal(matchTag('android', '1.4 (75)', ['studios-1.4-75']).tag, 'studios-1.4-75');
});

test('tags that tie are one answer on the same commit, and none otherwise', () => {
  const tags = ['v1.4-75', 'release-1.4-75'];
  assert.deepEqual(matchTag('android', '1.4 (75)', tags), { tag: null, ambiguous: ['release-1.4-75', 'v1.4-75'] });
  assert.equal(matchTag('android', '1.4 (75)', tags, { commitOf: () => 'abc' }).tag, 'release-1.4-75');
  assert.deepEqual(matchTag('android', '1.4 (75)', tags, { commitOf: (t) => t }).ambiguous, ['release-1.4-75', 'v1.4-75']);
});

test("a project's own patterns override the name matching", () => {
  const own = ['release-android-1.4.75', 'v1.4-75'];
  assert.equal(matchTag('android', '1.4 (75)', own, { patterns: ['release-{platform}-{version}.{build}'] }).tag, 'release-android-1.4.75');
  assert.equal(matchTag('android', '1.4 (75)', own, { patterns: ['nope-{build}'] }).tag, null);
});

test('latest is the newest version with crashes, or the newest tagged one when any is tagged', () => {
  const versions = ['1.4 (75)', '1.4 (77)', '1.3 (71)'];
  assert.equal(latestOf(versions, () => null), '1.4 (77)');
  assert.equal(latestOf(versions, tagOf('android', ['android/v1.4-75', 'android/v1.3-71'])), '1.4 (75)');
  assert.equal(latestOf([], () => null), null);
});

test('a run picks latest, all, a tag, a Crashlytics name or a version alone', () => {
  const versions = ['1.4 (75)', '1.4 (77)', '1.3 (71)', '1.3 (70)'];
  const tags = ['android/v1.4-75', 'v1.3'];
  const pick = (wanted) => selectReleases(wanted, { versions, tags, tagOf: tagOf('android', tags) });
  assert.deepEqual([...pick(['latest'])], ['1.4 (75)']);
  assert.equal(pick(['all']), null);
  assert.deepEqual([...pick(['v1.3'])], ['1.3 (71)', '1.3 (70)']);
  assert.deepEqual([...pick(['1.4 (77)', '2.0'])], ['1.4 (77)', '2.0']);
  assert.throws(() => pick(['v2.0']), /"v2.0" is neither a release tag in this repo, a Crashlytics version name/);
  assert.throws(() => selectReleases(['latest'], { versions: [], tags, tagOf: () => null }), /"latest": no versions with crashes/);
});

test('a crash is in a release by its exact build, or by its version for a release named without one', () => {
  const wanted = new Set(['1.4 (75)', '1.9']);
  assert.equal(inReleases(wanted, '1.4 (75)'), true);
  assert.equal(inReleases(wanted, '1.4 (76)'), false);
  assert.equal(inReleases(wanted, '1.9 (80)'), true);
  assert.equal(inReleases(wanted, '1.9.1 (81)'), false);
  assert.equal(inReleases(wanted, undefined), false);
});
