import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.mjs';
import { noteMessage, prMessage, sendAlerts } from '../src/notify.mjs';
import { tempDir } from './tmp.mjs';

const ok = { ok: true, status: 204 };

test('a PR alert names the PR, its link, the crash and what the proof showed', () => {
  const text = prMessage({ title: 'Restoring the Words tab no longer crashes', url: 'https://github.com/o/r/pull/7', issues: ['f26e8107'], result: 'proven' });
  assert.match(text, /^de-kaput opened a pull request: Restoring the Words tab no longer crashes\nhttps:\/\/github\.com\/o\/r\/pull\/7\nCrashlytics f26e8107: a test crashes on the base/);
  assert.match(prMessage({ title: 't', url: 'u', issues: ['a', 'b'], result: 'fixed-on-main' }), /Crashlytics a, b: already fixed on main/);
});

test('a note alert carries the note and the console link; long text is cut', () => {
  assert.equal(noteMessage({ issue: 'c7a03546', note: 'de-kaput: note. No message.', uri: 'https://console' }), 'de-kaput added a Crashlytics note on c7a03546:\nde-kaput: note. No message.\nhttps://console');
  assert.ok(noteMessage({ issue: 'x', note: 'n'.repeat(5000) }).length <= 1900);
});

test('Discord gets content, Slack gets text; a missing variable or a failed post only warns', async () => {
  const sent = [];
  const warnings = [];
  const fetchFn = async (url, { body }) => {
    sent.push([url, JSON.parse(body)]);
    return url.includes('broken') ? { ok: false, status: 500 } : ok;
  };
  const targets = [
    { type: 'discord', webhookEnv: 'D' },
    { type: 'slack', webhookEnv: 'S' },
    { type: 'slack', webhookEnv: 'UNSET' },
    { type: 'discord', webhookEnv: 'BROKEN' },
  ];
  const env = { D: 'https://discord.test/hook', S: 'https://slack.test/hook', BROKEN: 'https://broken.test/hook' };
  const results = await sendAlerts(targets, 'hello', { env, fetchFn, warn: (l) => warnings.push(l) });
  assert.deepEqual(sent.slice(0, 2), [['https://discord.test/hook', { content: 'hello' }], ['https://slack.test/hook', { text: 'hello' }]]);
  assert.deepEqual(results.map((r) => r.sent), [true, true, false, false]);
  assert.deepEqual(warnings, ['slack alert skipped: UNSET is not set', 'discord alert failed: HTTP 500']);
  const thrown = await sendAlerts([{ type: 'discord', webhookEnv: 'D' }], 'x', { env, fetchFn: async () => { throw new Error('offline'); }, warn: (l) => warnings.push(l) });
  assert.deepEqual(thrown, [{ type: 'discord', sent: false }]);
  assert.equal(warnings.at(-1), 'discord alert failed: offline');
});

test('notify in the config names an environment variable, never the webhook URL', () => {
  const config = (notify) => parseConfig(`version: 1\nnotify: ${notify}\napps:\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n`);
  assert.deepEqual(config('[{type: discord, webhook-env: DEKAPUT_DISCORD_WEBHOOK}]').notify, [{ type: 'discord', webhookEnv: 'DEKAPUT_DISCORD_WEBHOOK' }]);
  assert.deepEqual(parseConfig('version: 1\napps:\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n').notify, []);
  assert.throws(() => config('[{type: teams, webhook-env: X}]'), /"type" must be one of discord, slack/);
  assert.throws(() => config('[{type: slack, webhook-env: "https://hooks.slack.com/services/T/B/x"}]'), /must name an environment variable/);
  assert.throws(() => config('{type: slack}'), /"notify" must be a list/);
});

test('dekaput notify --test posts to the config\'s webhook', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(204).end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = tempDir('dekaput-notify-');
  fs.mkdirSync(path.join(dir, '.github'));
  fs.writeFileSync(path.join(dir, '.github/de-kaput.yml'), 'version: 1\nnotify: [{type: discord, webhook-env: DEKAPUT_TEST_WEBHOOK}]\napps:\n  - platform: ios\n    crashlytics-app-id: "1:1:ios:x"\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const bin = fileURLToPath(new URL('../bin/dekaput.mjs', import.meta.url));
  const env = { ...process.env, DEKAPUT_TEST_WEBHOOK: `http://127.0.0.1:${server.address().port}/hook` };
  const run = spawn('node', [bin, 'notify', '--test'], { cwd: dir, env });
  let stdout = '';
  run.stdout.on('data', (c) => { stdout += c; });
  const code = await new Promise((resolve) => run.on('close', resolve));
  server.close();
  assert.equal(code, 0);
  assert.equal(stdout.trim(), 'discord: sent');
  assert.match(received[0].content, /^de-kaput test alert/);
});
