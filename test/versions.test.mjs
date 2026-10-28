import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFor } from '../src/versions.mjs';

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
