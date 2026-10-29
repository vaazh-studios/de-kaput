# Configuration

Add `.github/de-kaput.yml` to your app's repo, next to `dependabot.yml`:

```yaml
version: 1
open-pull-requests-limit: 5        # most de-kaput PRs open at once
reviewers: [your-github-name]      # asked to review every PR
notify:                            # optional: a message when a PR opens or a note is added
  - type: discord                  # or slack
    webhook-env: DEKAPUT_DISCORD_WEBHOOK   # the environment variable holding the webhook URL

apps:
  - name: android
    platform: android              # android or ios
    crashlytics-app-id: "1:1234567890:android:abc123"
    packages: [com.example.app]    # your app's own Kotlin and Java code
    ignore-frames: [com.example.app.crashreporting]   # your crash reporter, never the cause
    probes: ["crash-reporting canary"]                # errors you raise on purpose
    release-tags: ["android/v{version}-{build}", "v{version}-{build}"]   # the default; set it only for your own pattern
    releases: latest               # or a release, or a list; leave it out to be asked each run
    modules:                       # where tests live, and what runs them
      - path: app
        gradle-task: ":app:testDebugUnitTest"
      - path: shared
        gradle-task: ":shared:testAndroidHostTest"

  - name: ios
    platform: ios
    crashlytics-app-id: "1:1234567890:ios:def456"
    modules:
      - path: ios                  # "." when the Xcode project is at the repo root
        xcode-scheme: App
        xcode-workspace: App.xcworkspace   # or xcode-project; neither for a Swift package
        xcode-destination: "platform=iOS Simulator,name=iPhone 17"   # optional: otherwise an iPhone on the newest iOS
        xcode-args: ["CODE_SIGNING_ALLOWED=NO"]   # optional: what your CI passes to xcodebuild
```

With it, the commands need no app-specific flags: `list` takes each crash's app by platform, and `verify` finds the Gradle task or Xcode scheme from the module that holds the new test. On iOS your app's own code is its Swift and Objective-C files in the repo, so `packages` only matters for Kotlin Multiplatform code; `xcode-destination` picks a simulator (otherwise an iPhone on the newest iOS installed), or `platform=macOS` for a package whose tests run on the Mac. Flags still win over the file. A mistake in the file is named, not guessed (`unknown key "open-pr-limit"`).

## Keys

`version`, each app's `platform` and `crashlytics-app-id`, and an Android app's `packages` are required. `modules` is what `verify` runs: an iOS app needs it (no flag stands in for an Xcode scheme), and without it an Android run must pass `--gradle-task`. The rest:

- `crashlytics-app-id` is the Firebase app id: `mobilesdk_app_id` in `google-services.json`, `GOOGLE_APP_ID` in `GoogleService-Info.plist`, or the App ID in the Firebase console's project settings. Only the agent uses it, to read Crashlytics.
- `name` defaults to the platform, `open-pull-requests-limit` to 5, and `reviewers` to nobody.
- `ignore-frames` are packages whose frames are passed over when looking for the crash's own code: your crash reporter or logger, which sits on every crash's stack (an unhandled-exception hook such as `com.example.app.crashreporting.CrashHandler.uncaughtException`).
- `probes` are regular expressions, matched without regard to case against the crash's exception line and message.
- `release-tags` default to `{platform}/v{version}-{build}`, then `v{version}-{build}`. `{version}` and `{build}` come from Crashlytics' name for the build, such as `1.4 (77)`, and `{platform}` is `android` or `ios`; the first pattern that names an existing tag wins. `{build}` matches digits only and `{version}` any text without spaces, so a tag such as `ios/v1.5-2026.10.29` is not read as a release, and a Crashlytics version without a build number in brackets matches no tag. Every pattern needs `{version}`; `{build}` is optional. Without it, as in `v{version}` for tags such as `v1.4.0`, each tag is one release covering every build of that version, and releases are ordered by version.
- `releases` picks the releases a run works on: `latest` (the newest tagged release, so it needs release tags), a release written as its tag (`android/v1.4-75`), as Crashlytics names it (`1.4 (75)`), or as a version alone (`1.4`, every build of it), or a list of them. Without it the agent asks you each run, listing the tagged releases (`dekaput releases` prints them). A release you name when you start the run wins over the file for its app; a tag names one app's release, while a Crashlytics name or a version applies to every app. A run nobody is watching needs it set.
- `notify` sends a short message to Discord or Slack when `open-pr` opens a pull request or the agent adds a note (`dekaput notify`). Each target names the environment variable that holds its webhook URL, so the URL stays out of the repo. A target whose variable is not set is skipped with a warning, and an alert never fails a run.
- The file can also be `de-kaput.yml` at the repo root.
