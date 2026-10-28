// Crashlytics version display names ("1.4 (75)") to the release tag that
// built them. A project's tags follow its own patterns ({platform},
// {version}, {build}); the default fits "<platform>/v<version>-<build>"
// with a bare "v<version>-<build>" fallback. Android and iOS build numbers
// can overlap, so another platform's tag is never a stand-in.

const DEFAULT_PATTERNS = ['{platform}/v{version}-{build}', 'v{version}-{build}'];

export function tagFor(platform, displayVersion, existingTags, patterns = DEFAULT_PATTERNS) {
  const match = /^(\S+) \((\d+)\)$/.exec(displayVersion.trim());
  if (!match) return null;
  for (const pattern of patterns) {
    const tag = pattern.replaceAll('{platform}', platform).replaceAll('{version}', match[1]).replaceAll('{build}', match[2]);
    if (existingTags.includes(tag)) return tag;
  }
  return null;
}
