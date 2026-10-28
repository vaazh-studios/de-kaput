// dekaput list: the release's crashes in order, and the next one to work on.
//
// Input: one normalised event file per issue (see classify.mjs), each with
//   issue: { id, title, subtitle, eventsCount, impactedUsersCount, uri }
//   notes: [{ body, createTime }]            (the issue's Crashlytics notes)
//   revision: <buildStamp revision>          (when the event has one)
// Fatal crashes only, ranked by users affected. A crash is handled when a
// de-kaput PR names its issue id (open or closed: a person answered it) or
// one of its notes starts with "de-kaput:". The next crash is the
// highest-ranked one that is not handled; one run works on that one only.

import { classifyIssue } from './classify.mjs';
import { deobfuscateEvent } from './mapping.mjs';
import { evidenceMarkdown } from './evidence.mjs';
import { tagFor } from './versions.mjs';

export const NOTE_PREFIX = 'de-kaput:';
export const PR_LABEL = 'de-kaput';

const handledBy = (issueId, prs, notes) => {
  const pr = prs.find((p) => `${p.title}\n${p.body}`.includes(issueId));
  if (pr) return `PR ${pr.url ?? pr.title} (${(pr.state ?? 'open').toLowerCase()})`;
  if (notes.some((n) => n.body.startsWith(NOTE_PREFIX))) return 'a de-kaput note';
  return null;
};

// The same crash can arrive twice: once with a readable class in its message,
// once with R8's short name for it ("Key sm8:currentTab"). Both shapes reduce to one key.
function shapeOf(subtitle, appPackages) {
  let s = subtitle ?? '';
  for (const pkg of appPackages) s = s.replace(new RegExp(`\\b${pkg.replace(/\./g, '\\.')}(?:\\.[\\w$]+)+`, 'g'), '<class>');
  return s.replace(/\b[a-z]{1,3}\d+\b/g, '<class>').trim();
}

export function listCrashes(events, { prs = [], options = {}, sourceSetOf = () => null, tags = [], mapping = null } = {}) {
  const fatal = events
    .filter((e) => e.errorType === 'FATAL')
    .map((e) => (mapping ? (({ event, decoded }) => ({ ...event, decoded }))(deobfuscateEvent(e, mapping)) : e));
  const ranked = [...fatal].sort(
    (a, b) => (b.issue?.impactedUsersCount ?? 0) - (a.issue?.impactedUsersCount ?? 0) || (b.issue?.eventsCount ?? 0) - (a.issue?.eventsCount ?? 0),
  );
  const crashes = ranked.map((event) => {
    const issue = { id: event.issueId, title: event.title, subtitle: event.subtitle, ...event.issue };
    return {
      issueId: event.issueId,
      platform: event.platform,
      title: event.title,
      subtitle: event.subtitle,
      users: issue.impactedUsersCount ?? null,
      events: issue.eventsCount ?? null,
      handled: handledBy(event.issueId, prs, event.notes ?? []),
      ...(event.decoded && Object.keys(event.decoded).length ? { decoded: event.decoded } : {}),
      ...classifyIssue(event, sourceSetOf, options),
      // Android events carry the build's git revision (buildStamp); it beats a tag lookup.
      release: event.revision ?? tagFor(event.platform.toLowerCase(), event.version, tags),
      evidence: evidenceMarkdown(issue, [event]),
    };
  });
  for (const crash of crashes) {
    if (crash.stop === 'attempt') continue;
    const shape = shapeOf(crash.subtitle, options.appPackages ?? []);
    const twin = crashes.find((c) => c !== crash && c.stop === 'attempt' && c.platform === crash.platform && shapeOf(c.subtitle, options.appPackages ?? []) === shape);
    if (twin) Object.assign(crash, { stop: 'same-as', sameAs: twin.issueId, reason: `the same crash as ${twin.issueId}; one fix covers both` });
  }
  // A twin ranks its group: when the top crash is the renamed copy, its readable twin is next.
  const resolve = (c) => (c.stop === 'same-as' ? crashes.find((t) => t.issueId === c.sameAs) : c);
  const next = crashes.map(resolve).find((c) => c && !c.handled && c.stop !== 'skip' && c.stop !== 'same-as') ?? null;
  return { crashes, next: next && { ...next, twins: crashes.filter((c) => c.sameAs === next.issueId).map((c) => c.issueId) }, otherCount: events.length - fatal.length };
}

export function formatList({ crashes, next, otherCount }) {
  const lines = crashes.map((c, i) => {
    const mark = c === next || c.issueId === next?.issueId ? '>' : ' ';
    const status = c.handled ? `handled: ${c.handled}` : `${c.stop}: ${c.reason}`;
    return `${mark} ${String(i + 1).padStart(2)}. ${c.issueId.slice(0, 8)} ${c.platform.toLowerCase()} users=${c.users ?? '?'} ${c.subtitle ?? c.title}\n       ${status}`;
  });
  if (otherCount) lines.push(`   (${otherCount} non-fatal issues not listed)`);
  lines.push(next ? `\nnext: ${next.issueId} (${next.stop})` : '\nnext: nothing left to work on');
  return lines.join('\n');
}
