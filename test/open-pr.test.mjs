import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofSection } from '../src/open-pr.mjs';

const base = { head: 'a'.repeat(40), base: 'b'.repeat(40), release: 'c'.repeat(40), task: ':app:test', test: '*T*', exception: 'java.lang.X', issue: 'i1', diffSha256: 'd'.repeat(64) };

test('a fixed-on-main proof shows the release crash and no runs that did not happen', () => {
  const md = proofSection({ ...base, result: 'fixed-on-main', anchor: { kind: 'message', text: 'currentTab was used multiple times' }, runs: { baseRun: { status: 'pass' }, tagRun: { status: 'fail', stack: 'java.lang.X: boom' } } }, ['i2']);
  assert.match(md, /with the message text "currentTab was used multiple times"/);
  assert.match(md, /On the release \(must crash\)/);
  assert.doesNotMatch(md, /not run/);
  assert.match(md, /Crashlytics issue i1, i2/);
});

test('a proven fix shows the base crash, the passing fix and the green suite', () => {
  const md = proofSection({ ...base, result: 'proven', anchor: { kind: 'frame', text: 'com.example.app.Parser.parse' }, runs: { baseRun: { status: 'fail', stack: 'java.lang.X: boom' }, headRun: { status: 'pass' }, suiteRun: { status: 'pass' } } });
  assert.match(md, /through the frame `com\.example\.app\.Parser\.parse`/);
  assert.match(md, /On the base \(must crash\)/);
  assert.match(md, /With the fix the test passes, and the whole suite is green/);
});

test('a message anchor that is a class says so', () => {
  const md = proofSection({ ...base, result: 'proven', anchor: { kind: 'message', text: 'com.example.app.ui.HomeTab' }, runs: { baseRun: { status: 'fail' }, headRun: { status: 'pass' }, suiteRun: { status: 'pass' } } });
  assert.match(md, /with the class `com\.example\.app\.ui\.HomeTab` in its message/);
});

test('tests that already fail on the base are named in the proof', () => {
  const md = proofSection({ ...base, result: 'proven', anchor: { kind: 'frame', text: 'static Parser.parse(_:)' }, runs: { baseRun: { status: 'fail', stack: 'EXC_BREAKPOINT' }, headRun: { status: 'pass' }, suiteRun: { status: 'pass', alreadyFailing: ['RSSParserTests/gb2312()', 'RSSParserTests/cjk()'] } } });
  assert.match(md, /no test that passes on the base fails with the fix \(2 already fail there: `RSSParserTests\/gb2312\(\)`, `RSSParserTests\/cjk\(\)`\)/);
  assert.doesNotMatch(md, /whole suite is green/);
});
