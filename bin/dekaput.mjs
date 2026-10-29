#!/usr/bin/env node
// de-kaput: reproduce a crash with a test, fix it, open a pull request with proof.
// See RUNBOOK.md for the order an agent runs these in.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { nativeFileFinder, sourceSetFinder } from '../src/classify.mjs';
import { appFor, listOptions, loadConfig } from '../src/config.mjs';
import { git, originRepo, repoRoot } from '../src/git.mjs';
import { formatList, listCrashes, PR_LABEL } from '../src/list.mjs';
import { parseMapping } from '../src/mapping.mjs';
import { OPEN_PR_OPTIONS, openPr } from '../src/open-pr.mjs';
import { dekaputDir } from '../src/receipt.mjs';
import { verify, VERIFY_OPTIONS } from '../src/verify.mjs';

const USAGE = `usage:
  dekaput list [--app <name>] [--mapping <mapping.txt>] [--max-prs <n>] [--json] <event files>
               (without .github/de-kaput.yml: --app-package <pkg> [--ignore-frame <pkg>] [--probe <regex>])
  dekaput verify --issue <id> --test <filter> --exception <class or signal> [--gradle-task <:module:task>]
                 --anchor <frame or class> [--anchor-kind frame|message] [--release <ref>]
                 (an Xcode filter is Target/Class/method or Target/function(); the exception EXC_BREAKPOINT, SIGABRT or an NSException name)
  dekaput open-pr --title <title> --body-file <file> [--also <issue id>]
  dekaput runbook   (prints the runbook the agent follows, the one that matches this CLI)`;

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
      // Most de-kaput PRs open at once, like Dependabot's open-pull-requests-limit.
      'max-prs': { type: 'string' },
      // Which config app to use for every crash, instead of matching by platform.
      app: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!positionals.length) throw new Error('give the event files to list');
  const root = repoRoot();
  // The crash events the agent wrote live in .dekaput/events/; keep them out of commits.
  dekaputDir(root);
  const config = loadConfig(root);
  // Flags win; otherwise each crash takes the config's app for its platform.
  const fromFlags = values['app-package'].length > 0;
  if (!fromFlags && !config) throw new Error("no .github/de-kaput.yml here; add one, or pass --app-package (the packages that are your app's own code)");
  const events = positionals.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const prs = values.prs
    ? JSON.parse(fs.readFileSync(values.prs, 'utf8'))
    : JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', originRepo(root), '--label', PR_LABEL, '--state', 'all', '--limit', '200', '--json', 'title,body,state,url'], { cwd: root, encoding: 'utf8' }));
  const result = listCrashes(events, {
    prs,
    tags: git(['tag'], root).split('\n').filter(Boolean),
    maxPrs: Number(values['max-prs'] ?? config?.openPullRequestsLimit ?? 5),
    optionsFor: fromFlags ? null : (event) => { const app = appFor(config, event.platform, values.app); return app && listOptions(app); },
    mapping: values.mapping ? parseMapping(fs.readFileSync(values.mapping, 'utf8')) : null,
    sourceSetOf: sourceSetFinder(git(['ls-files', '*.kt', '*.java'], root).split('\n')),
    nativeFileOf: nativeFileFinder(git(['ls-files', '*.swift', '*.m', '*.mm'], root).split('\n')),
    options: {
      appPackages: values['app-package'],
      ignoreFrames: values['ignore-frame'],
      probes: values.probe.map((p) => new RegExp(p, 'i')),
    },
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : formatList(result));
}

const [command, ...args] = process.argv.slice(2);
const asksForHelp = (arg) => arg === '--help' || arg === '-h';
try {
  // Help is never an error: bare, "help", or --help after any command.
  if (!command || command === 'help' || asksForHelp(command) || args.some(asksForHelp)) console.log(USAGE);
  else if (command === '--version' || command === '-v') console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  else if (command === 'list') list(args);
  else if (command === 'verify') {
    const result = verify(parseArgs({ args, options: VERIFY_OPTIONS }).values);
    console.log(JSON.stringify(result.ok ? result.receipt : { ok: false, reproduced: result.reproduced, reason: result.reason, runs: result.runs }, null, 2));
    // 3: reproduced, the fix is still to write; 1: rejected.
    process.exitCode = result.ok ? 0 : result.reproduced ? 3 : 1;
  } else if (command === 'open-pr') console.log(openPr(parseArgs({ args, options: OPEN_PR_OPTIONS }).values));
  // Read from the installed package, wherever npm, pnpm or Volta put it.
  else if (command === 'runbook') process.stdout.write(fs.readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8'));
  else {
    console.log(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`dekaput: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
