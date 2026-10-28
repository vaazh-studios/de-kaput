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

test('with the release mapping, a renamed class in the message makes the crash workable', () => {
  const mapping = new Map([['sm8', 'com.example.app.ui.tabs.HomeTab']]);
  const only = [fixture('android-currenttab-obfuscated.json', { id: 'f26e', impactedUsersCount: 2, eventsCount: 5 })];
  const without = listCrashes(only, { options, sourceSetOf: inMain }).next;
  assert.equal(without.stop, 'attempt');
  assert.deepEqual(without.anchor, { kind: 'message', text: 'currentTab was used multiple times', sourceSet: null });
  const { next } = listCrashes(only, { options, sourceSetOf: inMain, mapping });
  assert.equal(next.stop, 'attempt');
  assert.equal(next.anchor.text, 'com.example.app.ui.tabs.HomeTab');
  assert.deepEqual(next.decoded, { sm8: 'com.example.app.ui.tabs.HomeTab' });
});

test('the queue holds every crash to work on, one per run step, in order', () => {
  const two = [
    fixture('android-currenttab.json', { id: 'e044', impactedUsersCount: 3, eventsCount: 3 }),
    { ...fixture('android-currenttab.json', { impactedUsersCount: 2, eventsCount: 2 }), issueId: 'other1', subtitle: 'java.lang.IllegalStateException - com.example.app.data.Repo failed', exceptions: 'java.lang.IllegalStateException: boom\nat com.example.app.data.Repo.load (Repo.kt:3)' },
    fixture('android-oom-kitatlas.json', { id: 'a2bf', impactedUsersCount: 1, eventsCount: 1 }),
  ];
  const { queue, next } = listCrashes(two, { options, sourceSetOf: inMain });
  assert.deepEqual(queue.map((c) => [c.issueId.slice(0, 6), c.stop]), [['e04405', 'attempt'], ['other1', 'attempt'], ['a2bfa6', 'note']]);
  assert.equal(next.issueId, queue[0].issueId);
});

test('like Dependabot, attempts wait once the open PR limit is reached; notes do not', () => {
  const two = [
    fixture('android-currenttab.json', { id: 'e044', impactedUsersCount: 3, eventsCount: 3 }),
    { ...fixture('android-currenttab.json', { impactedUsersCount: 2, eventsCount: 2 }), issueId: 'other1', subtitle: 'java.lang.IllegalStateException - com.example.app.data.Repo failed', exceptions: 'java.lang.IllegalStateException: boom\nat com.example.app.data.Repo.load (Repo.kt:3)' },
    fixture('android-oom-kitatlas.json', { id: 'a2bf', impactedUsersCount: 1, eventsCount: 1 }),
  ];
  const prs = [{ title: 'x', body: 'an unrelated crash', state: 'OPEN' }];
  const { queue, waiting } = listCrashes(two, { options, sourceSetOf: inMain, prs, maxPrs: 2 });
  assert.deepEqual(queue.map((c) => c.issueId.slice(0, 6)), ['e04405', 'a2bfa6']);
  assert.deepEqual(waiting.map((c) => c.issueId), ['other1']);
});
