// Crashlytics version display names ("1.4 (75)") to the release tag that
// built them. Release tags are "<platform>/v<name>-<build>" since 1.4; older
// releases have only the bare "v<name>-<build>". Android and iOS build numbers
// overlap, so another platform's tag is never a stand-in.

export function tagFor(platform, displayVersion, existingTags) {
  const match = /^(\S+) \((\d+)\)$/.exec(displayVersion.trim());
  if (!match) return null;
  const bare = `v${match[1]}-${match[2]}`;
  for (const tag of [`${platform}/${bare}`, bare]) {
    if (existingTags.includes(tag)) return tag;
  }
  return null;
}
