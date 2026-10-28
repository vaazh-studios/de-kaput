import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listCrashes } from '../src/list.mjs';

const fixture = (name, issue) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')), issue, notes: [] });
const options = { appPackages: ['com.example.app'], ignoreFrames: ['com.example.app.crashreporting'] };
const inMain = () => 'commonMain';

const events = [
  fixture('android-oom-kitatlas.json', { id: 'a2bf', impactedUsersCount: 1, eventsCount: 1 }),
  fixture('android-currenttab-obfuscated.json', { id: 'f26e', impactedUsersCount: 2, eventsCount: 5 }),
  fixture('android-currenttab.json', { id: 'e044', impactedUsersCount: 1, eventsCount: 1 }),
  { ...fixture('android-currenttab.json', { impactedUsersCount: 40 }), issueId: 'nonfatal1', errorType: 'NON_FATAL' },
];

test('fatal crashes only, most users first', () => {
  const { crashes, otherCount } = listCrashes(events, { options, sourceSetOf: inMain });
  assert.deepEqual(crashes.map((c) => c.users), [2, 1, 1]);
  assert.equal(otherCount, 1);
});

test('the next crash is the top one that can be worked on, with its R8-renamed twin', () => {
  const { next } = listCrashes(events, { options, sourceSetOf: inMain });
  assert.equal(next.issueId, 'e044059c5755177f4b64b53959007b68');
  assert.equal(next.stop, 'attempt');
  assert.deepEqual(next.twins, ['f26e8107ace4f9542b53486a6a1a42af']);
});

test('a crash with a de-kaput PR, open or closed, is handled', () => {
  const prs = [{ title: 'test(tabs): x', body: 'Crashlytics issue e044059c5755177f4b64b53959007b68', state: 'CLOSED' }];
  const { crashes, next } = listCrashes(events, { prs, options, sourceSetOf: inMain });
  assert.match(crashes.find((c) => c.issueId.startsWith('e044')).handled, /closed/);
  assert.equal(next.stop, 'note');
});

test('a de-kaput note marks a crash handled; other notes do not', () => {
  const noted = events.map((e) => (e.issueId.startsWith('a2bf') ? { ...e, notes: [{ body: 'de-kaput: out of memory' }] } : e));
  assert.equal(listCrashes(noted, { options, sourceSetOf: inMain }).crashes.find((c) => c.issueId.startsWith('a2bf')).handled, 'a de-kaput note');
  const human = events.map((e) => (e.issueId.startsWith('a2bf') ? { ...e, notes: [{ body: 'seen on my Pixel' }] } : e));
  assert.equal(listCrashes(human, { options, sourceSetOf: inMain }).crashes.find((c) => c.issueId.startsWith('a2bf')).handled, null);
});

test('the release comes from the build revision when the event has one', () => {
  const { crashes } = listCrashes(events, { options, sourceSetOf: inMain });
  assert.equal(crashes[0].release, '1f0e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c');
});
