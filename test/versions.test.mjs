import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasesFor, selectReleases, tagFor } from '../src/versions.mjs';

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
