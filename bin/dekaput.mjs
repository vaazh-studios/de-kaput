#!/usr/bin/env node
// de-kaput: reproduce a crash with a test, fix it, open a pull request with proof.
// See RUNBOOK.md for the order an agent runs these in.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { sourceSetFinder } from '../src/classify.mjs';
import { git, repoRoot } from '../src/git.mjs';
import { formatList, listCrashes, PR_LABEL } from '../src/list.mjs';
import { parseMapping } from '../src/mapping.mjs';
import { OPEN_PR_OPTIONS, openPr } from '../src/open-pr.mjs';
import { verify, VERIFY_OPTIONS } from '../src/verify.mjs';

const USAGE = `usage:
  dekaput list --app-package <pkg> [--ignore-frame <pkg>] [--probe <regex>] [--mapping <mapping.txt>] [--json] <event files>
  dekaput verify --issue <id> --gradle-task <:module:task> --test <filter> --exception <class>
                 --anchor <frame or class> [--anchor-kind frame|message] [--release <ref>]
  dekaput open-pr --title <title> --body-file <file> [--also <issue id>]`;

function list(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'app-package': { type: 'string', multiple: true, default: [] },
      'ignore-frame': { type: 'string', multiple: true, default: [] },
      probe: { type: 'string', multiple: true, default: [] },
      prs: { type: 'string' },
      // The release build's R8 mapping.txt, to read renamed class names in crash messages.
      mapping: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!positionals.length) throw new Error('give the event files to list');
  if (!values['app-package'].length) throw new Error('--app-package is required: the packages that are your app\'s own code');
  const root = repoRoot();
  const events = positionals.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const prs = values.prs
    ? JSON.parse(fs.readFileSync(values.prs, 'utf8'))
    : JSON.parse(execFileSync('gh', ['pr', 'list', '--label', PR_LABEL, '--state', 'all', '--limit', '200', '--json', 'title,body,state,url'], { cwd: root, encoding: 'utf8' }));
  const result = listCrashes(events, {
    prs,
    tags: git(['tag'], root).split('\n').filter(Boolean),
    mapping: values.mapping ? parseMapping(fs.readFileSync(values.mapping, 'utf8')) : null,
    sourceSetOf: sourceSetFinder(git(['ls-files', '*.kt', '*.java'], root).split('\n')),
    options: {
      appPackages: values['app-package'],
      ignoreFrames: values['ignore-frame'],
      probes: values.probe.map((p) => new RegExp(p, 'i')),
    },
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : formatList(result));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'list') list(args);
  else if (command === 'verify') {
    const result = verify(parseArgs({ args, options: VERIFY_OPTIONS }).values);
    console.log(JSON.stringify(result.ok ? result.receipt : { ok: false, reason: result.reason, runs: result.runs }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === 'open-pr') console.log(openPr(parseArgs({ args, options: OPEN_PR_OPTIONS }).values));
  else {
    console.log(USAGE);
    process.exitCode = command && command !== 'help' ? 2 : 0;
  }
} catch (error) {
  console.error(`dekaput: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
