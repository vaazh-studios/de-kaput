// Which stop point a Crashlytics issue gets: skip, note, or attempt a fix.
//
// The event is the run's own normalised copy of one Crashlytics sample event,
// written from crashlytics_batch_get_events with only these fields (so user
// ids, install ids, custom keys and logs never enter it):
//   { issueId, platform: 'ANDROID'|'IOS', errorType: 'FATAL'|'NON_FATAL'|'ANR',
//     title, subtitle, version: '1.4 (77)', device: 'Google (sdk_gphone64_arm64)',
//     os, exceptions: <verbatim>, threads: <verbatim> }
//
// sourceSetOf(fileName, className) says which source set holds a file
// ('main', 'commonMain', 'androidMain', 'iosMain', ...) or null when the repo has none.
//
// options (all from the app, nothing is built in):
//   appPackages: ['com.example.app'] - code that counts as the app's own
//   ignoreFrames: ['com.example.app.crashreporting'] - the app's own crash reporter,
//     which sits on every unhandled-exception path and is never the cause
//   probes: [/crash-reporting canary/i] - errors the app raises on purpose

// Source sets the JVM host tests cannot run (Kotlin/Native and Apple targets).
const NOT_ON_THE_JVM = /^(ios|apple|native|macos|watchos|tvos|linux|mingw|js|wasm)/i;
const INTERNAL_DEVICE = /sdk_gphone|emulator|simulator|generic_x86/i;

export function parseFrames(text) {
  const frames = [];
  for (const line of text.split('\n')) {
    const match = /^\s*at\s+(.+?)(?:\s+\(([^)]*)\))?\s*$/.exec(line);
    if (!match) continue;
    let symbol = match[1];
    if (symbol.startsWith('kfun:')) symbol = symbol.slice(5).split('(')[0].replace('#', '.');
    const file = match[2]?.split(':')[0];
    frames.push({ symbol, file: file && file.includes('.') ? file : null });
  }
  return frames;
}

function exceptionOf(event) {
  const first = (event.exceptions ?? '').split('\n')[0];
  const line = first && !first.trim().startsWith('at ') ? first : event.subtitle ?? '';
  const [type, ...rest] = line.split(/: | - /);
  return { type: type.trim(), message: rest.join(': ').trim() };
}

const prefixes = (packages) => packages.map((p) => (p.endsWith('.') ? p : `${p}.`));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const classOf = (symbol) => symbol.slice(0, symbol.lastIndexOf('.'));

function anchored(kind, text, sourceSet, exception) {
  if (sourceSet && !NOT_ON_THE_JVM.test(sourceSet)) {
    return { stop: 'attempt', reason: `${exception} anchored on ${text} (${sourceSet})`, exception, anchor: { kind, text, sourceSet } };
  }
  const where = sourceSet ?? 'no file in this repo';
  return { stop: 'note', reason: `${text} is in ${where}; the JVM tests cannot reproduce it`, exception };
}

function decide(event, sourceSetOf, { appPackages = [], ignoreFrames = [], probes = [] }) {
  const { type, message } = exceptionOf(event);
  if (probes.some((p) => p.test(`${event.subtitle ?? ''}\n${message}`))) {
    return { stop: 'skip', reason: 'a deliberate crash-reporting probe, expected' };
  }
  // Non-fatals are errors the app caught and reported itself (mostly network).
  if (event.errorType === 'NON_FATAL') return { stop: 'skip', reason: 'non-fatal: an error the app caught and reported; not attempted' };
  if (event.errorType === 'ANR') return { stop: 'skip', reason: 'ANR: main-thread stalls need a trace, not a unit test' };
  if (type.endsWith('OutOfMemoryError')) {
    return { stop: 'note', reason: 'OutOfMemoryError: memory pressure needs profiling, not a unit test' };
  }
  const frames = parseFrames(`${event.exceptions ?? ''}\n${event.threads ?? ''}`);
  if (frames.some((f) => f.symbol.includes('konan::') || f.symbol === 'Kotlin_processUnhandledException')) {
    return {
      stop: 'note',
      reason: 'Kotlin/Native aborted on an unhandled exception; the report has no Kotlin exception or message. ' +
        'Needs the exception logged before the abort (or a device log) to go further',
    };
  }
  if (frames.length === 0 || frames.every((f) => /^0x[0-9a-f]+$/i.test(f.symbol))) {
    return { stop: 'note', reason: 'no symbolicated frames; needs symbols (dSYM or mapping) for this build' };
  }
  const app = prefixes(appPackages);
  const ignored = prefixes(ignoreFrames);
  const isAppSymbol = (symbol) => app.some((p) => symbol.startsWith(p)) && !ignored.some((p) => symbol.startsWith(p));
  const top = frames.find((f) => isAppSymbol(f.symbol));
  if (top) return anchored('frame', top.symbol, sourceSetOf(top.file, classOf(top.symbol)), type);
  const appClassInText = app.length
    ? new RegExp(`\\b((?:${app.map((p) => escape(p.slice(0, -1))).join('|')})(?:\\.[A-Za-z_$][\\w$]*)+)`)
    : null;
  const named = appClassInText?.exec(message)?.[1];
  if (named) {
    const simple = named.split('.').pop();
    const sourceSet = sourceSetOf(`${simple}.kt`, named) ?? sourceSetOf(`${simple}.java`, named);
    return anchored('message', named, sourceSet, type);
  }
  // A class named only by its R8 name ("Key sm8:currentTab was used ..."): without the
  // exact build's mapping, anchor on the message's own words around it. The agent finds
  // the code that writes that message; the proof still needs the same message, thrown
  // from outside the test.
  const literal = stableText(message);
  if (literal) {
    return {
      stop: 'attempt',
      reason: `${type}: the message names a class only by its R8 name; anchored on its text "${literal}" (find the code that writes it, or pass the release mapping)`,
      exception: type,
      anchor: { kind: 'message', text: literal, sourceSet: null },
    };
  }
  return { stop: 'skip', reason: 'every frame is in system or library code and the message names no app class' };
}

// An R8 name written as a class is in a message: short letters with a digit, right before ':', '.' or '$'.
const R8_NAME = /\b[a-z]{1,3}\d+[a-z]?(?=[:.$])/g;

// The longest run of the message between R8 names, when the message has any; at least three words.
export function stableText(message) {
  if (!R8_NAME.test(message ?? '')) return null;
  R8_NAME.lastIndex = 0;
  const pieces = message.split(R8_NAME).map((p) => p.replace(/^[\s:.$]+|\s+$/g, ''));
  const longest = pieces.sort((a, b) => b.length - a.length)[0] ?? '';
  return longest.split(/\s+/).length >= 3 ? longest : null;
}

export const isInternalDevice = (device) => INTERNAL_DEVICE.test(device ?? '');

export function classifyIssue(event, sourceSetOf, options = {}) {
  return { ...decide(event, sourceSetOf, options), internalDevice: isInternalDevice(event.device) };
}

// sourceSetOf over the repo's file list (git ls-files): the file whose path
// ends with the class's package path and file name, under src/<set>/kotlin or src/<set>/java.
export function sourceSetFinder(paths) {
  return (fileName, className) => {
    if (!fileName || !className) return null;
    const pkgPath = className.split('.').slice(0, -1).join('/');
    const hit = paths.find((p) => p.endsWith(`/kotlin/${pkgPath}/${fileName}`) || p.endsWith(`/java/${pkgPath}/${fileName}`));
    return hit ? /\/src\/([^/]+)\/(?:kotlin|java)\//.exec(hit)?.[1] ?? null : null;
  };
}
