// Crashlytics version display names ("1.4 (75)") to the release tag that
// built them. A project's tags follow its own patterns ({platform},
// {version}, {build}); the default fits "<platform>/v<version>-<build>"
// with a bare "v<version>-<build>" fallback. Android and iOS build numbers
// can overlap, so another platform's tag is never a stand-in. A pattern
// without {build} ("v{version}") makes each tag one release for every build
// of its version, named by the version alone ("1.4").

const DEFAULT_PATTERNS = ['{platform}/v{version}-{build}', 'v{version}-{build}'];
const DISPLAY = /^(\S+) \((\d+)\)$/;
const VERSION_ALONE = /^\d+(\.\d+)*$/;

export function tagFor(platform, displayVersion, existingTags, patterns = DEFAULT_PATTERNS) {
  const match = DISPLAY.exec(displayVersion.trim());
  if (!match) return null;
  for (const pattern of patterns) {
    const tag = pattern.replaceAll('{platform}', platform).replaceAll('{version}', match[1]).replaceAll('{build}', match[2]);
    if (existingTags.includes(tag)) return tag;
  }
  return null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CAPTURE = { '{version}': '(?<version>\\S+?)', '{build}': '(?<build>\\d+)' };

// A tag read back through a pattern: "ios/v1.4-77" -> { name: "1.4 (77)", build: 77 },
// and "v1.4" through "v{version}" -> { name: "1.4", build: null }.
function parseTag(platform, tag, pattern) {
  const source = pattern
    .split(/(\{platform\}|\{version\}|\{build\})/)
    .map((part) => (part === '{platform}' ? escape(platform) : CAPTURE[part] ?? escape(part)))
    .join('');
  const match = new RegExp(`^${source}$`).exec(tag);
  if (!match) return null;
  const { version, build } = match.groups;
  return build === undefined ? { name: version, version, tag, build: null } : { name: `${version} (${build})`, version, tag, build: Number(build) };
}

// "1.10" after "1.9": versions compared number by number.
function compareVersions(a, b) {
  const x = a.split(/\D+/).filter(Boolean).map(Number);
  const y = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.localeCompare(b);
}
const newestFirst = (a, b) => (a.build !== null && b.build !== null ? b.build - a.build : compareVersions(b.version, a.version));

// The platform's tagged releases, newest (highest build, or version) first, one per name.
export function releasesFor(platform, existingTags, patterns = DEFAULT_PATTERNS) {
  const found = new Map();
  for (const pattern of patterns) {
    for (const tag of existingTags) {
      const release = parseTag(platform, tag, pattern);
      if (release && !found.has(release.name)) found.set(release.name, release);
    }
  }
  return [...found.values()].sort(newestFirst);
}

// The release names a run works on, from what a person wrote: "latest", a tag
// ("ios/v1.4-77"), a Crashlytics name ("1.4 (77)") or a version alone ("1.4", every
// build of it). A name or a version stands as written, so a release with no tag can
// still be named; another platform's tag picks nothing here.
export function selectReleases(platform, wanted, existingTags, patterns = DEFAULT_PATTERNS) {
  const releases = releasesFor(platform, existingTags, patterns);
  const names = new Set();
  for (const entry of wanted) {
    const text = entry.trim();
    if (text === 'latest') {
      if (!releases.length) throw new Error(`"latest": no ${platform} tag matches the release tags (${patterns.join(', ')}); tag your releases, or name one such as "1.4 (77)"`);
      names.add(releases[0].name);
    } else if (DISPLAY.test(text)) {
      names.add(text);
    } else {
      const release = releases.find((r) => r.tag === text || r.name === text);
      if (release) names.add(release.name);
      else if (VERSION_ALONE.test(text)) names.add(text);
      else if (!existingTags.includes(text)) throw new Error(`"${text}" is neither a release tag in this repo, a Crashlytics version name such as "1.4 (77)", nor a version such as "1.4"`);
    }
  }
  return names;
}

// Whether a crash's Crashlytics version ("1.4 (75)") is one of the releases: by its
// exact name, or by its version for a release named without a build ("1.4").
export const inReleases = (wanted, displayVersion) => wanted.has(displayVersion) || wanted.has(DISPLAY.exec(displayVersion ?? '')?.[1]);
