import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/dekaput.mjs', import.meta.url));

test('runbook prints the RUNBOOK.md that ships with the CLI', () => {
  const printed = execFileSync('node', [bin, 'runbook'], { cwd: '/', encoding: 'utf8' });
  assert.equal(printed, fs.readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8'));
});
