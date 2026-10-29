// The Crashlytics evidence a PR body or note carries. Built from an allowlist
// of fields (issue counts, versions, devices, OS, the stack), never by removing
// fields, so whatever else an event holds stays out. Free text inside the
// stack (exception messages) is scrubbed of ids, emails and tokens.

import { isInternalDevice } from './classify.mjs';

const MAX_FRAMES = 15;
// Edges are "not a letter or digit" rather than \b, so ids joined by "_" are
// still caught. Firebase uids with no digit at all can still slip through.
const ALNUM_EDGE_START = '(?<![A-Za-z0-9])';
const ALNUM_EDGE_END = '(?![A-Za-z0-9])';
const SCRUB = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<token>'],
  [/\bBearer\s+\S+/gi, 'Bearer <token>'],
  [/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, '<id>'],
  [new RegExp(`${ALNUM_EDGE_START}[0-9A-Fa-f]{32,}${ALNUM_EDGE_END}`, 'g'), '<id>'],
  // Firebase uids: 28 letters and digits with at least one digit.
  [new RegExp(`${ALNUM_EDGE_START}(?=[A-Za-z]*\\d)[A-Za-z0-9]{28}${ALNUM_EDGE_END}`, 'g'), '<uid>'],
  // Firebase installation ids: 22 base64url characters starting c-f, with a digit.
  [/(?<![\w-])(?=[\w-]*\d)[c-f][\w-]{21}(?![\w-])/g, '<id>'],
];

export const redact = (text) => SCRUB.reduce((out, [pattern, mask]) => out.replace(pattern, mask), String(text ?? ''));

function stackOf(event) {
  const source = event.exceptions?.trim() ? event.exceptions : event.threads ?? '';
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0]?.startsWith('at ') ? [] : lines.slice(0, 1);
  const frames = lines.filter((l) => l.startsWith('at ')).slice(0, MAX_FRAMES);
  return [...head, ...frames].map(redact).join('\n');
}

function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([v, n]) => `${v} x${n}`).join(', ');
}

export function evidenceMarkdown(issue, events) {
  const devices = events.map((e) => (isInternalDevice(e.device) ? `${e.device} (emulator or simulator)` : e.device));
  return [
    `### Crashlytics issue ${issue.id}`,
    '',
    `**${redact(issue.title)}**`,
    redact(issue.subtitle ?? ''),
    '',
    `- Events: ${issue.eventsCount}, users: ${issue.impactedUsersCount}`,
    `- First seen ${issue.firstSeenVersion ?? 'unknown'}, last seen ${issue.lastSeenVersion ?? 'unknown'}; sampled builds: ${tally(events.map((e) => e.version))}`,
    `- Devices: ${tally(devices)}`,
    `- OS: ${tally(events.map((e) => e.os))}`,
    `- [Open in Crashlytics](${issue.uri})`,
    '',
    '```text',
    stackOf(events[0]),
    '```',
  ].join('\n');
}
