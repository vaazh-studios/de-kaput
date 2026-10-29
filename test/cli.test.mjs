import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/dekaput.mjs', import.meta.url));
const run = (...args) => spawnSync('node', [bin, ...args], { cwd: '/', encoding: 'utf8' });

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
