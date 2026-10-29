// Releases and their tags. A release is a version Crashlytics names ("1.4 (75)",
// version then build). A tag is only an identifier, so it is found by name: the
// tag that holds the build's version and build number, whatever else it says.
// A project whose names are ambiguous can give its own patterns ({platform},
// {version}, {build}) instead. Android and iOS build numbers can overlap, so a
// tag that names the other platform is never a stand-in.

const DISPLAY = /^(.+?) \(([^)]+)\)$/;
const VERSION_ALONE = /^\d+(\.\d+)*$/;
const PLATFORMS = ['android', 'ios'];

// "1.4 (75)" -> { version: "1.4", build: "75" }; a name without a build in brackets is all version.
export function splitVersion(name) {
  const match = DISPLAY.exec(name.trim());
  return match ? { version: match[1], build: match[2] } : { version: name.trim(), build: null };
}

// "1.10" after "1.9": numbers compared as numbers, then the text.
function compareParts(a, b) {
  const x = a.split(/\D+/).filter(Boolean).map(Number);
  const y = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.localeCompare(b);
}

// Newest first: by version, then by build.
export function newestFirst(a, b) {
  const x = splitVersion(a);
  const y = splitVersion(b);
  return compareParts(y.version, x.version) || compareParts(y.build ?? '', x.build ?? '');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Where a value stands on its own in a tag: no digit or dot right before it, no digit or ".digit" right after.
const standing = (tag, value) => new RegExp(`(^|[^0-9.])${escape(value)}(?![0-9]|\\.[0-9])`).exec(tag);
const otherDigits = (tag, value) => /[0-9]/.test(tag.replace(value, ''));
// A platform is named by a word that starts with it ("ios", "iosBeta"), not by "studios".
const names = (tag, platform) => (tag.toLowerCase().match(/[a-z]+/g) ?? []).some((word) => word.startsWith(platform));

// How well a tag names the build: version and build, the build alone, or the version alone (every build of it).
function fit(tag, { version, build }) {
  const hasVersion = standing(tag, version);
  const hasBuild = build !== null && build !== version && standing(tag, build);
  if (hasVersion && hasBuild) return 3;
  if (hasBuild && !otherDigits(tag, build)) return 2;
  if (hasVersion && !otherDigits(tag, version)) return 1;
  return 0;
}

// The tag a build was made from, by name, or by the project's own patterns.
// { tag, ambiguous }: tied tags on one commit are one answer; on different commits, none.
export function matchTag(platform, displayVersion, tags, { patterns = null, commitOf = null } = {}) {
  if (!displayVersion) return { tag: null, ambiguous: [] };
  const parts = splitVersion(displayVersion);
  if (patterns) {
    for (const pattern of patterns) {
      const tag = pattern.replaceAll('{platform}', platform).replaceAll('{version}', parts.version).replaceAll('{build}', parts.build ?? '');
      if (tags.includes(tag)) return { tag, ambiguous: [] };
    }
    return { tag: null, ambiguous: [] };
  }
  const others = PLATFORMS.filter((p) => p !== platform);
  const scored = tags
    .filter((tag) => !others.some((other) => names(tag, other)))
    .map((tag) => ({ tag, score: fit(tag, parts) + (names(tag, platform) ? 0.5 : 0) }))
    .filter((t) => t.score >= 1);
  if (!scored.length) return { tag: null, ambiguous: [] };
  const best = Math.max(...scored.map((t) => t.score));
  const tied = scored.filter((t) => t.score === best).map((t) => t.tag).sort();
  if (tied.length === 1 || (commitOf && new Set(tied.map(commitOf)).size === 1)) return { tag: tied[0], ambiguous: [] };
  return { tag: null, ambiguous: tied };
}

// The newest version with crashes, or the newest tagged one when any is tagged.
export function latestOf(versions, tagOf) {
  const sorted = [...versions].sort(newestFirst);
  return sorted.find((name) => tagOf(name)) ?? sorted[0] ?? null;
}

// The version names a run works on, from what a person wrote: "latest", "all" (null:
// no filter), a tag, a Crashlytics name ("1.4 (77)") or a version alone ("1.4", every
// build of it). A name or a version stands as written; another platform's tag picks nothing.
export function selectReleases(wanted, { versions, tags, tagOf }) {
  if (wanted.some((entry) => entry.trim() === 'all')) return null;
  const known = new Set(versions.map((v) => splitVersion(v).version));
  const picked = new Set();
  for (const entry of wanted) {
    const text = entry.trim();
    if (text === 'latest') {
      const latest = latestOf(versions, tagOf);
      if (!latest) throw new Error('"latest": no versions with crashes to pick from; read topVersions first (runbook step 1), or name a release such as "1.4 (77)"');
      picked.add(latest);
    } else if (DISPLAY.test(text) || VERSION_ALONE.test(text) || known.has(text)) {
      picked.add(text);
    } else if (tags.includes(text)) {
      for (const v of versions) if (tagOf(v) === text) picked.add(v);
    } else {
      throw new Error(`"${text}" is neither a release tag in this repo, a Crashlytics version name such as "1.4 (77)", nor a version such as "1.4"`);
    }
  }
  return picked;
}

// Whether a crash's Crashlytics version ("1.4 (75)") is one of the releases: by its
// exact name, or by its version for a release named without a build ("1.4").
export const inReleases = (wanted, displayVersion) => wanted.has(displayVersion) || wanted.has(DISPLAY.exec(displayVersion ?? '')?.[1]);
