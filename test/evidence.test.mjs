import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceMarkdown, redact } from '../src/evidence.mjs';

const event = JSON.parse(readFileSync(new URL('./fixtures/android-oom-kitatlas.json', import.meta.url), 'utf8'));
const issue = {
  id: event.issueId,
  title: event.title,
  subtitle: event.subtitle,
  eventsCount: 1,
  impactedUsersCount: 1,
  firstSeenVersion: '1.4',
  lastSeenVersion: '1.4',
  uri: 'https://console.firebase.google.com/v1/appid/project/example-app/crashlytics/app/x/issues/a2bf',
};
const uid = 'Zq8RtW2mXk4NcV7bPa1LdY9sHe3G';
const install = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9';
// The run is told to copy only the normalised fields; this one also carries
// what Crashlytics returns around them, and text with personal data inside.
const leaky = {
  ...event,
  version: '1.4 (75)',
  user: { id: uid },
  installationUuid: install,
  customKeys: { tier: 'free', deviceName: 'Nirmal iPhone' },
  logs: '[nav] screen to=words email=pat@example.com',
  exceptions: `java.lang.IllegalStateException: no wordbook for ${uid} (pat@example.com) token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc\n` +
    event.exceptions.split('\n').slice(1).join('\n'),
};

test('the evidence leaves out ids, emails, tokens, custom keys and logs', () => {
  const md = evidenceMarkdown(issue, [leaky]);
  for (const secret of [uid, install, 'pat@example.com', 'eyJhbGciOiJIUzI1NiJ9', 'Nirmal iPhone', 'screen to=words']) {
    assert.ok(!md.includes(secret), `leaked ${secret}`);
  }
});

test('the evidence keeps the frames, version, device and console link', () => {
  const md = evidenceMarkdown(issue, [leaky]);
  assert.ok(md.includes('at com.example.app.scene.TileAtlas.compose (TileAtlas.kt:59)'));
  assert.ok(md.includes('1.4 (75)'));
  assert.ok(md.includes('Google (sdk_gphone64_arm64)'));
  assert.ok(md.includes(issue.uri));
  assert.ok(md.includes(issue.id));
});

test('the stack stops at 15 frames', () => {
  const many = { ...event, exceptions: ['java.lang.X: y', ...Array.from({ length: 30 }, (_, i) => `at com.a.B.m${i} (B.kt:${i})`)].join('\n') };
  const md = evidenceMarkdown(issue, [many]);
  assert.ok(md.includes('m14 (B.kt:14)'));
  assert.ok(!md.includes('m15 (B.kt:15)'));
});

test('redact masks dashed UUIDs, installation ids and uids joined by an underscore', () => {
  const text = `install 3f2c9a1e-4b7d-4e2a-9c1f-7a6b5c4d3e2f fid dK9fR2xLQZ-mN7pW_3vT0a key uid_${uid}`;
  const out = redact(text);
  for (const secret of ['3f2c9a1e-4b7d', 'dK9fR2xLQZ-mN7pW_3vT0a', uid]) assert.ok(!out.includes(secret), `leaked ${secret}`);
});

test('redact keeps class names that look like ids', () => {
  assert.equal(redact('at com.a.SaveableStateHolderImplLambda.invoke'), 'at com.a.SaveableStateHolderImplLambda.invoke');
});

test('an event file without the first and last seen versions says unknown, not undefined', () => {
  const { firstSeenVersion, lastSeenVersion, ...older } = issue;
  const markdown = evidenceMarkdown(older, [event]);
  assert.match(markdown, /First seen unknown, last seen unknown/);
  assert.doesNotMatch(markdown, /undefined/);
});
