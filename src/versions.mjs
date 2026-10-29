// Crashlytics version display names ("1.4 (75)") to the release tag that
// built them. A project's tags follow its own patterns ({platform},
// {version}, {build}); the default fits "<platform>/v<version>-<build>"
// with a bare "v<version>-<build>" fallback. Android and iOS build numbers
// can overlap, so another platform's tag is never a stand-in.

const DEFAULT_PATTERNS = ['{platform}/v{version}-{build}', 'v{version}-{build}'];
const DISPLAY = /^(\S+) \((\d+)\)$/;

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

// A tag read back through a pattern: "ios/v1.4-77" -> { name: "1.4 (77)", build: 77 }.
function parseTag(platform, tag, pattern) {
  const source = pattern
    .split(/(\{platform\}|\{version\}|\{build\})/)
    .map((part) => (part === '{platform}' ? escape(platform) : CAPTURE[part] ?? escape(part)))
    .join('');
  const match = new RegExp(`^${source}$`).exec(tag);
  return match ? { name: `${match.groups.version} (${match.groups.build})`, tag, build: Number(match.groups.build) } : null;
}

// The platform's tagged releases, newest (highest build) first, one per Crashlytics name.
export function releasesFor(platform, existingTags, patterns = DEFAULT_PATTERNS) {
  const found = new Map();
  for (const pattern of patterns) {
    for (const tag of existingTags) {
      const release = parseTag(platform, tag, pattern);
      if (release && !found.has(release.name)) found.set(release.name, release);
    }
  }
  return [...found.values()].sort((a, b) => b.build - a.build);
}

// The Crashlytics names a run works on, from what a person wrote: "latest", a tag
// ("ios/v1.4-77") or a Crashlytics name ("1.4 (77)"). A name stands as written, so a
// release with no tag can still be named; another platform's tag picks nothing here.
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
      const release = releases.find((r) => r.tag === text);
      if (release) names.add(release.name);
      else if (!existingTags.includes(text)) throw new Error(`"${text}" is neither a release tag in this repo nor a Crashlytics version name such as "1.4 (77)"`);
    }
  }
  return names;
}
