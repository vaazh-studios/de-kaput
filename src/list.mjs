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

// options: { appPackages, ignoreFrames, probes, releaseTags } for every crash, or
// optionsFor(event) to pick them per crash (the config's app for its platform; null when none).
// releasesOf(platform): the Crashlytics version names this run works on, or null for any.
export function listCrashes(events, { prs = [], options = {}, optionsFor = null, sourceSetOf = () => null, nativeFileOf = () => null, tags = [], mapping = null, maxPrs = 5, releasesOf = () => null } = {}) {
  const optsOf = (event) => (optionsFor ? optionsFor(event) : options);
  // A crash from a version the run was not asked for is set aside, so a wrong fetch never becomes a PR.
  const outsideReleases = (event) => {
    const wanted = releasesOf(event.platform.toLowerCase());
    return wanted && !wanted.has(event.version) ? { stop: 'skip', reason: `from ${event.version ?? 'an unknown version'}, not a release this run works on (${[...wanted].join(', ')})` } : null;
  };
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
      version: event.version ?? null,
      users: issue.impactedUsersCount ?? null,
      events: issue.eventsCount ?? null,
      handled: handledBy(event.issueId, prs, event.notes ?? []),
      appPackages: optsOf(event)?.appPackages ?? [],
      ...(event.decoded && Object.keys(event.decoded).length ? { decoded: event.decoded } : {}),
      ...(outsideReleases(event) ?? (optsOf(event) ? classifyIssue(event, sourceSetOf, { ...optsOf(event), nativeFileOf }) : { stop: 'skip', reason: `no app for ${event.platform.toLowerCase()} in the config` })),
      // Android events carry the build's git revision (buildStamp); it beats a tag lookup.
      release: event.revision ?? tagFor(event.platform.toLowerCase(), event.version, tags, optsOf(event)?.releaseTags),
      evidence: evidenceMarkdown(issue, [event]),
    };
  });
  // A crash anchored only on message text rides with a twin anchored on a real class.
  const classAnchored = (c) => c.stop === 'attempt' && c.anchor?.sourceSet != null;
  for (const crash of crashes) {
    if (classAnchored(crash)) continue;
    const shape = shapeOf(crash.subtitle, crash.appPackages);
    const twin = crashes.find((c) => c !== crash && classAnchored(c) && c.platform === crash.platform && shapeOf(c.subtitle, c.appPackages) === shape);
    if (twin) Object.assign(crash, { stop: 'same-as', sameAs: twin.issueId, reason: `the same crash as ${twin.issueId}; one fix covers both` });
  }
  // A twin ranks its group: when the top crash is the renamed copy, its readable twin takes its place.
  const resolve = (c) => (c.stop === 'same-as' ? crashes.find((t) => t.issueId === c.sameAs) : c);
  const workable = crashes.map(resolve).filter((c) => c && !c.handled && c.stop !== 'skip' && c.stop !== 'same-as');
  // Like Dependabot's open-pull-requests-limit: attempts beyond the free PR slots wait for the next run.
  let slots = Math.max(0, maxPrs - prs.filter((p) => (p.state ?? 'OPEN') === 'OPEN').length);
  const queue = [...new Set(workable)].map((c) => {
    const twins = crashes.filter((t) => t.sameAs === c.issueId).map((t) => t.issueId);
    if (c.stop !== 'attempt') return { ...c, twins };
    if (slots === 0) return { ...c, twins, waiting: `the PR limit (${maxPrs} open) is reached; next run` };
    slots -= 1;
    return { ...c, twins };
  });
  const ready = queue.filter((c) => !c.waiting);
  return { crashes, queue: ready, waiting: queue.filter((c) => c.waiting), next: ready[0] ?? null, otherCount: events.length - fatal.length };
}

export function formatList({ crashes, queue, waiting, otherCount }) {
  const order = new Map(queue.map((c, i) => [c.issueId, i + 1]));
  const lines = crashes.map((c, i) => {
    const mark = order.has(c.issueId) ? `q${order.get(c.issueId)}` : '  ';
    const wait = waiting.find((w) => w.issueId === c.issueId);
    const status = c.handled ? `handled: ${c.handled}` : wait ? `waiting: ${wait.waiting}` : `${c.stop}: ${c.reason}`;
    return `${mark} ${String(i + 1).padStart(2)}. ${c.issueId.slice(0, 8)} ${c.platform.toLowerCase()} users=${c.users ?? '?'} ${c.subtitle ?? c.title}\n       ${status}`;
  });
  if (otherCount) lines.push(`   (${otherCount} non-fatal issues not listed)`);
  lines.push(queue.length ? `\nqueue: ${queue.map((c) => `${c.issueId.slice(0, 8)} (${c.stop})`).join(', ')}` : '\nqueue: nothing left to work on');
  return lines.join('\n');
}
