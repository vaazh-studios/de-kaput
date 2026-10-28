// Reading R8-renamed class names in a crash message back to their real names.
//
// Crashlytics deobfuscates stack frames with the uploaded mapping, but not the
// exception message. So a message like "Key sm8:currentTab was used multiple
// times" names the app's class only by its R8 name, and list cannot tell it is
// app code. With the release build's mapping.txt, the name can be read back.
// The mapping must come from the exact build that crashed: another build's
// mapping gives the same short names to different classes.

// A class line: "com.example.Foo -> sm8:". Member lines are indented and skipped.
const CLASS_LINE = /^(\S+) -> (\S+):$/;

export function parseMapping(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = CLASS_LINE.exec(line);
    if (match) map.set(match[2], match[1]);
  }
  return map;
}

// Only tokens that look like R8 output count: with a digit (sm8, s5c), or written
// right before ':' or '$' the way a class name is (sm8:currentTab). A plain word
// such as "was" stays a word even when R8 happened to use it as a name.
const TOKEN = /(?<![\w$.])([A-Za-z_$][\w$]*)(?=([:$])?)/g;

function decodeMessage(line, map, decoded) {
  return line.replace(TOKEN, (token, name, after) => {
    const real = map.get(name);
    if (!real || !(/\d/.test(name) || after)) return token;
    decoded[name] = real;
    return real;
  });
}

// The subtitle and the first line of the exception text are the message;
// frames below it are left as they are.
export function deobfuscateEvent(event, map) {
  const decoded = {};
  const [first = '', ...frames] = (event.exceptions ?? '').split('\n');
  const out = {
    ...event,
    subtitle: decodeMessage(event.subtitle ?? '', map, decoded),
    exceptions: [decodeMessage(first, map, decoded), ...frames].join('\n'),
  };
  return { event: out, decoded };
}
