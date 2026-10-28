// Runs one xcodebuild test action on an iOS simulator and reads its result bundle.
//
// filter is an -only-testing identifier: Target, Target/Class or Target/Class/method
// (Swift Testing: Target/Suite/function() or Target/function()). Swift Testing
// runs a target's tests in parallel, so one crash ends the others; verify runs one.
// A test that crashed the test process gets its type and frames from its crash
// log: the one the result bundle attaches, or else the one the Mac's crash
// reporter wrote (xcodebuild skips a crash that comes seconds after another).
// An NSException that XCTest caught gets them from XCTest's own report. The
// Swift runtime's message ("Fatal error: ...") is only in xcodebuild's output.
// A frame is own code (the app's or the tests') when its image is one the build
// made: the app, its debug dylib, a test bundle, a framework.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Remote Swift packages are fetched once, for every worktree.
const PACKAGES = path.join(os.tmpdir(), 'dekaput-packages');
const CRASH_REPORTS = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
const SIGNALS = { trap: 'SIGTRAP', abort: 'SIGABRT', abrt: 'SIGABRT', segv: 'SIGSEGV', bus: 'SIGBUS', ill: 'SIGILL', kill: 'SIGKILL' };

const xcrun = (args, input) =>
  execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });

// An iPhone simulator on the newest iOS installed. xcodebuild boots it for the run and shuts it down after.
export function pickDestination(devices = JSON.parse(xcrun(['simctl', 'list', 'devices', 'available', '-j'])).devices) {
  const version = (runtime) => (/iOS-(\d+)-(\d+)/.exec(runtime) ?? [0, 0, 0]).slice(1).map(Number);
  const phones = Object.entries(devices)
    .filter(([runtime]) => runtime.includes('SimRuntime.iOS-'))
    .flatMap(([runtime, list]) => list.filter((d) => d.name.startsWith('iPhone')).map((d) => ({ udid: d.udid, version: version(runtime) })))
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
  if (!phones.length) throw new Error('no iPhone simulator is installed; add one in Xcode, or set xcode-destination');
  return `platform=iOS Simulator,id=${phones[0].udid}`;
}

// The images a build made, by the names stacks give them: bundles by their name
// ("Toast Catalog", "Toast CatalogTests"), dylibs by their file ("Toast Catalog.debug.dylib").
export function ownImages(productsDir) {
  const names = new Set();
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const bundle = /\.(app|appex|xctest|framework)$/.exec(entry.name);
      if (bundle) names.add(entry.name.slice(0, -bundle[0].length));
      else if (entry.name.endsWith('.dylib')) names.add(entry.name);
      if (entry.isDirectory() && depth < 5) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(productsDir, 0);
  return names;
}

// The test cases a result bundle ran (by suite, as classes) and the first that failed.
export function parseTestResults(tree) {
  const ran = new Set();
  let failed = null;
  const walk = (node, suite) => {
    if (node.nodeType !== 'Test Case') {
      for (const child of node.children ?? []) walk(child, node.nodeType === 'Test Suite' ? node.name : suite);
      return;
    }
    if (node.result === 'Skipped') return;
    // A Swift Testing function outside any suite ran by its own name.
    ran.add(suite ?? methodOf(node.name));
    if (node.result === 'Failed' && !failed) {
      const messages = (node.children ?? []).filter((c) => c.nodeType === 'Failure Message').map((c) => c.name);
      failed = { id: node.nodeIdentifier, name: node.name, messages };
    }
  };
  for (const node of tree.testNodes ?? []) walk(node, null);
  return { ran: [...ran], failed };
}

const frameOf = (images) => (f) => ({
  symbol: f.symbol ?? `${images[f.imageIndex]?.name ?? '?'} + ${f.imageOffset}`,
  file: f.sourceFile ? path.basename(f.sourceFile) : null,
  line: f.sourceLine ?? null,
  image: images[f.imageIndex]?.name ?? null,
});

// A crash log (.ips: a JSON header line, then the JSON report).
export function parseCrashLog(text) {
  const report = JSON.parse(text.slice(text.indexOf('\n') + 1));
  const toFrame = frameOf(report.usedImages ?? []);
  // An uncaught NSException's throw stack is lastExceptionBacktrace; a device's log also names it in the
  // application-specific info, a simulator's does not (uncaughtIn reads the name from the run's output).
  const info = Object.values(report.asi ?? {}).flat().join('\n');
  const uncaught = /uncaught exception '([^']+)', reason: '([\s\S]*?)'/.exec(info);
  const thrown = report.lastExceptionBacktrace;
  const crashed = report.threads?.[report.faultingThread]?.frames ?? [];
  return {
    type: uncaught?.[1] ?? report.exception?.type ?? null,
    signal: report.exception?.signal ?? null,
    message: uncaught?.[2] ?? '',
    frames: (thrown ?? crashed).map(toFrame),
    thrown: Boolean(thrown),
  };
}

const demangle = (symbols) =>
  symbols.length ? xcrun(['swift-demangle', '--simplified'], `${symbols.join('\n')}\n`).split('\n').slice(0, symbols.length) : [];

// XCTest's report of an exception it caught: 'failed: caught "Name", "reason"', then the call stack.
export function parseCaughtException(text, demangleAll = demangle) {
  const head = /caught "([^"]+)", "([\s\S]*?)"\n/.exec(text);
  if (!head) return null;
  // "7   Toast Catalog.debug.dylib   0x0000000102eee390 $s13Toast_Catalog... + 304": image names can hold spaces.
  const rows = [...text.matchAll(/^\s*\d+\s+(.+?)\s+0x[0-9a-f]+\s+(.+?) \+ \d+$/gm)];
  const symbols = demangleAll(rows.map((r) => r[2]));
  return { type: head[1], message: head[2], frames: rows.map((r, i) => ({ symbol: symbols[i], file: null, line: null, image: r[1] })) };
}

const methodOf = (testName) => testName.replace(/\(.*\)$/, '');

// An uncaught NSException's name and reason as the run printed them: XCTest's
// 'caught "Name", "reason"', or the runtime's "uncaught exception 'Name', reason: 'reason'".
export function uncaughtIn(output, testName) {
  const text = output.slice(Math.max(0, output.indexOf(methodOf(testName))));
  const hit = /uncaught exception '([^']+)', reason: '([^\n]*?)'/.exec(text) ?? /caught "([^"]+)", "([^\n]*?)"/.exec(text);
  return hit ? { type: hit[1], message: hit[2] } : null;
}

// The test's own crash report from the Mac's crash reporter: written since the
// run started, by a process in a simulator, with the test method on a thread.
export function crashReportFor(testName, since, dir = CRASH_REPORTS) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.ips')).map((f) => path.join(dir, f));
  } catch {
    return null;
  }
  const call = `.${methodOf(testName)}(`;
  const recent = files.map((file) => ({ file, at: fs.statSync(file).mtimeMs })).filter((f) => f.at >= since).sort((a, b) => b.at - a.at);
  for (const { file } of recent) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const report = JSON.parse(text.slice(text.indexOf('\n') + 1));
      const named = (report.threads ?? []).some((t) => (t.frames ?? []).some((f) => f.symbol?.includes(call)));
      if (report.parentProc === 'launchd_sim' && named) return text;
    } catch {
      // Not a JSON crash report.
    }
  }
  return null;
}

// The Swift runtime's message for the test's crash: "Fatal error: Unexpectedly found nil ...".
export function fatalMessage(output, testName) {
  const from = Math.max(0, output.indexOf(methodOf(testName)));
  return /((?:Fatal error|Precondition failed|Assertion failed): [^\n]*)/.exec(output.slice(from))?.[1] ?? '';
}

// The stack as text for the receipt: from the first frame of own code (the runtime's and the OS's frames before it say nothing).
function stackText(head, frames) {
  const first = Math.max(0, frames.findIndex((f) => f.own || f.file));
  return [head, ...frames.slice(first).map((f) => `\tat ${f.symbol}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`)].join('\n');
}

export function crashFailure({ type, signal, message, frames }, fatal = '') {
  const text = [fatal, message].filter(Boolean).join('\n');
  const head = `${type}${signal && signal !== type ? ` (${signal})` : ''}${text ? `: ${text}` : ''}`;
  return { failureType: type, signal, message: text, frames, stack: stackText(head, frames) };
}

// XCTest's own failure location is where the test called in, not the throw site; the frames say where it was thrown.
export function caughtFailure({ type, message, frames }) {
  return { failureType: type, signal: null, message, frames, stack: stackText(`${type}: ${message}`, frames) };
}

// The test's attachments: its crash log (.ips) or XCTest's description of what it caught (.txt).
function attachmentsOf(bundle, testId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-attachments-'));
  try {
    xcrun(['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', dir, '--test-id', testId]);
    const read = (ext) => fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))[0] ?? null;
    return { crashLog: read('.ips'), description: read('.txt') };
  } catch {
    return { crashLog: null, description: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function failureOf(bundle, failed, output, since, own) {
  const message = failed.messages[0] ?? '';
  const crashed = /^(Crash: |Test crashed)/.test(message);
  const { crashLog, description } = attachmentsOf(bundle, failed.id);
  const mark = (failure) => ({ ...failure, frames: failure.frames.map((f) => ({ ...f, own: own.has(f.image) })) });
  const report = crashLog ?? (crashed ? crashReportFor(failed.name, since) : null);
  if (report) {
    const crash = parseCrashLog(report);
    const named = crash.thrown && /^(EXC_|SIG)/.test(crash.type ?? '') ? uncaughtIn(output, failed.name) : null;
    return named ? crashFailure(mark({ ...crash, ...named })) : crashFailure(mark(crash), fatalMessage(output, failed.name));
  }
  const caught = description && parseCaughtException(description);
  if (caught) return caughtFailure(mark(caught));
  if (crashed) {
    const signal = SIGNALS[/signal (\w+)/.exec(message)?.[1]?.toLowerCase()] ?? null;
    return { failureType: signal ?? 'crash', signal, message, frames: [], stack: `${message}\n(no crash log for it, in the result bundle or the crash reporter's folder)` };
  }
  return { failureType: 'a test assertion', signal: null, message, frames: [], stack: message };
}

export function xcodeRun({ dir, module, filter, destination, derivedData }) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dekaput-xcresult-'));
  const bundle = path.join(out, 'run.xcresult');
  const { scheme, workspace, project } = module.xcode;
  const args = [
    'test', '-scheme', scheme, '-destination', destination,
    ...(workspace ? ['-workspace', workspace] : project ? ['-project', project] : []),
    ...(filter ? [`-only-testing:${filter}`] : []),
    '-resultBundlePath', bundle,
    '-derivedDataPath', derivedData,
    '-clonedSourcePackagesDirPath', PACKAGES,
    // After a crash xcodebuild otherwise collects a sysdiagnose from the simulator (10 minutes, then a timeout).
    '-collect-test-diagnostics', 'never',
  ];
  try {
    const since = Date.now();
    const run = spawnSync('xcodebuild', args, { cwd: path.join(dir, module.path), encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    let tree = null;
    try {
      tree = fs.existsSync(bundle) ? JSON.parse(xcrun(['xcresulttool', 'get', 'test-results', 'tests', '--path', bundle, '--compact'])) : null;
    } catch {
      tree = null;
    }
    const { ran, failed } = tree ? parseTestResults(tree) : { ran: [], failed: null };
    if (ran.length === 0) {
      const errors = output.split('\n').filter((l) => / error: /.test(l));
      console.error((errors.length ? errors.slice(0, 20) : output.trim().split('\n').slice(-20)).map((l) => `xcodebuild: ${l}`).join('\n'));
      return { status: 'error' };
    }
    if (!failed) return { status: run.status === 0 ? 'pass' : 'error', ran };
    return { status: 'fail', ran, ...failureOf(bundle, failed, output, since, ownImages(path.join(derivedData, 'Build', 'Products'))) };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
