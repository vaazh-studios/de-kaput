// Runs one Gradle test task and reads its JUnit XML.
//
// task is a full task path, e.g. :app:testDebugUnitTest or
// :shared:presentation:testAndroidHostTest. Every run is a real run:
// --rerun forces the test task to execute, and the build cache is off, so a
// repeat or a CI re-check never returns a cached result.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseJUnit } from '../proof.mjs';

export function resultsDir(dir, task) {
  const parts = task.split(':').filter(Boolean);
  return path.join(dir, ...parts.slice(0, -1), 'build', 'test-results', parts.at(-1));
}

export function gradleRun({ dir, task, filter }) {
  const results = resultsDir(dir, task);
  fs.rmSync(results, { recursive: true, force: true });
  const args = [task, '--rerun', '--no-build-cache', ...(filter ? ['--tests', filter] : []), '--quiet'];
  const exit = spawnSync('./gradlew', args, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }).status;
  const xml = fs.existsSync(results)
    ? fs.readdirSync(results).filter((f) => f.endsWith('.xml')).map((f) => fs.readFileSync(path.join(results, f), 'utf8'))
    : [];
  const run = parseJUnit(xml);
  // A build that failed after the tests (or before any ran) is not a pass.
  return exit !== 0 && run.status === 'pass' ? { status: 'error' } : run;
}
