// Temp folders a test file makes, removed when its process exits, so test runs leave nothing behind.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
