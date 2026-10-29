import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inReleases, releasesFor, selectReleases, tagFor } from '../src/versions.mjs';

const tags = ['ios/v1.4-77', 'android/v1.4-75', 'ios/v1.4-75', 'android/v1.3-71', 'ios/v1.3-71', 'v1.3-71', 'v1.2-64'];

test('a platform tag wins', () => {
  assert.equal(tagFor('android', '1.4 (75)', tags), 'android/v1.4-75');
  assert.equal(tagFor('ios', '1.4 (77)', tags), 'ios/v1.4-77');
});

test('the bare tag is the fallback', () => {
  assert.equal(tagFor('android', '1.2 (64)', tags), 'v1.2-64');
});

test('another platform tag is never used', () => {
  assert.equal(tagFor('android', '1.4 (77)', tags), null);
});

test('a version Crashlytics did not format as name (build) gives null', () => {
  assert.equal(tagFor('ios', '1.4', tags), null);
});

test("a project's own tag patterns are used in order", () => {
  const own = ['release-android-1.4.75', 'v1.4-75'];
  assert.equal(tagFor('android', '1.4 (75)', own, ['release-{platform}-{version}.{build}']), 'release-android-1.4.75');
  assert.equal(tagFor('android', '1.4 (75)', own, ['nope-{build}', 'v{version}-{build}']), 'v1.4-75');
});

test("a platform's releases come back from its tags, newest build first", () => {
  assert.deepEqual(releasesFor('ios', tags).map((r) => [r.name, r.tag]), [
    ['1.4 (77)', 'ios/v1.4-77'], ['1.4 (75)', 'ios/v1.4-75'], ['1.3 (71)', 'ios/v1.3-71'], ['1.2 (64)', 'v1.2-64'],
  ]);
  assert.deepEqual(releasesFor('android', tags).map((r) => r.name), ['1.4 (75)', '1.3 (71)', '1.2 (64)']);
  assert.deepEqual(releasesFor('android', ['release-android-1.4.75'], ['release-{platform}-{version}.{build}']).map((r) => r.name), ['1.4 (75)']);
});

test('a run picks releases as "latest", a tag or a Crashlytics name', () => {
  assert.deepEqual([...selectReleases('ios', ['latest'], tags)], ['1.4 (77)']);
  assert.deepEqual([...selectReleases('android', ['latest'], tags)], ['1.4 (75)']);
  assert.deepEqual([...selectReleases('ios', ['ios/v1.3-71', '1.4 (75)'], tags)], ['1.3 (71)', '1.4 (75)']);
  // A name with no tag (an untagged build) still stands; another platform's tag picks nothing.
  assert.deepEqual([...selectReleases('android', ['1.4 (77)', 'ios/v1.4-77'], tags)], ['1.4 (77)']);
});

test('a release that is not there is named, not guessed', () => {
  assert.throws(() => selectReleases('ios', ['ios/v9.9-99'], tags), /"ios\/v9.9-99" is neither a release tag/);
  assert.throws(() => selectReleases('ios', ['latest'], []), /"latest": no ios tag matches/);
});

test('a tag without a build number is one release for every build of its version', () => {
  const own = ['v1.4', 'v1.10', 'v1.9', 'android/v1.4-75'];
  assert.equal(tagFor('android', '1.9 (80)', own, ['v{version}']), 'v1.9');
  assert.deepEqual(releasesFor('android', own, ['v{version}']).map((r) => [r.name, r.tag]), [['1.10', 'v1.10'], ['1.9', 'v1.9'], ['1.4', 'v1.4']]);
  assert.deepEqual([...selectReleases('android', ['latest'], own, ['v{version}'])], ['1.10']);
  assert.deepEqual([...selectReleases('android', ['v1.9', '1.4'], own, ['v{version}'])], ['1.9', '1.4']);
});

test('a version alone names every build of it, on any app; a mistyped tag still does not', () => {
  assert.deepEqual([...selectReleases('ios', ['2.0', '1.4.1'], tags)], ['2.0', '1.4.1']);
  assert.throws(() => selectReleases('ios', ['v2.0'], tags), /"v2.0" is neither a release tag/);
});

test('a crash is in a release by its exact build, or by its version for a release without one', () => {
  const wanted = new Set(['1.4 (75)', '1.9']);
  assert.equal(inReleases(wanted, '1.4 (75)'), true);
  assert.equal(inReleases(wanted, '1.4 (76)'), false);
  assert.equal(inReleases(wanted, '1.9 (80)'), true);
  assert.equal(inReleases(wanted, '1.9.1 (81)'), false);
  assert.equal(inReleases(wanted, undefined), false);
});
