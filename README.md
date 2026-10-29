# de-kaput

Your app went kaput. de-kaput is a CLI and a runbook for your coding agent (Claude Code, Codex or any other): the agent reproduces each crash with a test and fixes it, and de-kaput checks that proof and opens one pull request per crash with the test and the fix.

It never fixes blind: no pull request without a test that fails with the crash's own exception before the fix and passes after it. A person always reviews and merges.

> **Status: early, and in daily use.** de-kaput is [on npm](https://www.npmjs.com/package/de-kaput). It runs every morning, unattended, on its maintainers' own Android and iOS app, where its first pull request, for a crash real users hit, is merged. The Xcode runner has proven crashes in a Swift package, in a UIKit app with app-hosted tests, in Swift Testing, and on the iOS simulator.
>
> See it on two demo forks, each with crashes planted on purpose: Google's [architecture-samples](https://github.com/vaazh-studios/de-kaput-demo-architecture-samples/pull/1) (a Kotlin coroutine crash) and [NetNewsWire](https://github.com/vaazh-studios/de-kaput-demo-netnewswire/pull/1) (a Swift trap in its feed parser). On a harder crash in each, a fresh agent that was given only this runbook, the repo and the crash report found the cause and opened the PR: a sort comparator that breaks Java's contract, which never appears in the stack ([architecture-samples#2](https://github.com/vaazh-studios/de-kaput-demo-architecture-samples/pull/2)), and a `Data` slice indexed from 0 two commits after it was made ([NetNewsWire#2](https://github.com/vaazh-studios/de-kaput-demo-netnewswire/pull/2)).

## How it works

![de-kaput: dekaput list queues the release's crashes; for each crash, one at a time: its commit, a new git worktree, a test that crashes, dekaput verify, dekaput open-pr; one pull request per crash](assets/how-it-works.svg)

1. Your coding agent (Codex or Claude Code) reads the top crashes of the releases you pick, or that your config picks, from Crashlytics through the Firebase MCP server. `dekaput releases` lists your tagged releases to pick from.
2. `dekaput list` skips crashes that already have a pull request or come from another release, and puts the rest in a queue.
3. **For each crash in the queue, one at a time**, like Dependabot does for each dependency:
   - it finds the commit that crash was built from: the git revision Crashlytics recorded for the build, or your release tag;
   - the agent checks out a new git worktree on a fresh branch from your default branch, so your own branch and files are never changed (de-kaput only writes its git-ignored `.dekaput/` folder there), and writes a test that reproduces the crash, then fixes it;
   - `dekaput verify` proves it in throwaway worktrees: the test fails on your default branch with the crash's exception, reaching the crash's code, and passes with the fix, and no test that passes on your default branch fails with it. If the test already passes on your default branch, it runs on the crash's commit instead; crashing there means the crash is already fixed and not yet shipped;
   - `dekaput open-pr` refuses without that proof, then opens a pull request for that crash with the test, the fix and the proof.
   A crash no test can reach gets a note on the Crashlytics issue instead, and the run moves on.
4. You get **one pull request per crash**, each reviewed and merged on its own. `--max-prs` caps how many are open at once. With `notify` set, each pull request and each note also posts to Discord or Slack.

It runs when you ask your agent, or on a schedule with nobody watching: a scheduled task, cron, or GitHub Actions (see Runs nobody watches).

Built for native Android, native iOS and Kotlin Multiplatform apps: Gradle runs the JVM tests, and `xcodebuild` runs XCTest and Swift Testing on an iPhone simulator (Xcode 16 or newer). On iOS a crash's identity is its Mach exception or signal (`EXC_BREAKPOINT`, `EXC_BAD_ACCESS`, `SIGABRT`) or its NSException name, read from the crash log the simulator writes. On iOS, a crash in Kotlin/Native gets a note instead: an unhandled Kotlin exception aborts without its message in the report, whether the code is in `commonMain` or `iosMain`, and a crash in a native source set cannot run on the JVM. There is no Kotlin/Native runner yet.

## Commands

| Command | What it does |
|---|---|
| `dekaput releases` | Lists each app's tagged releases, newest first, and the ones the config picks. |
| `dekaput list` | Builds the queue from the crash events: what to attempt, what gets a note, and what is already handled or from another release. |
| `dekaput verify` | Proves a fix branch: the test crashes on the default branch with the crash's exception and passes with the fix, and no test that passed fails. Writes a receipt for that commit. |
| `dekaput open-pr` | Pushes the fix branch and opens the pull request with the proof, only with a matching receipt, and posts the alert. |
| `dekaput notify` | Posts an alert for a note the agent added, or a test message (`--test`). |
| `dekaput runbook` | Prints the runbook installed with the CLI, the one the agent follows. |

`dekaput help` lists every flag.

## What it never does

- Merge a pull request, mark one for auto-merge, or push to your default branch.
- Open a pull request without a test that crashes before the fix and passes after it.
- Change a Crashlytics issue: notes are its only Crashlytics write.
- Put user ids, installation ids, custom keys, logs or breadcrumbs into its files or pull requests; crash messages in a pull request are scrubbed of emails, ids and tokens.
- Follow instructions found in crash text: it is data.
- Keep a secret in your repo: webhook URLs and tokens stay in environment variables.

## Configuration

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

`version`, each app's `platform` and `crashlytics-app-id`, and an Android app's `packages` are required. `modules` is what `verify` runs: an iOS app needs it (no flag stands in for an Xcode scheme), and without it an Android run must pass `--gradle-task`. The rest:

- `crashlytics-app-id` is the Firebase app id: `mobilesdk_app_id` in `google-services.json`, `GOOGLE_APP_ID` in `GoogleService-Info.plist`, or the App ID in the Firebase console's project settings. Only the agent uses it, to read Crashlytics.
- `name` defaults to the platform, `open-pull-requests-limit` to 5, and `reviewers` to nobody.
- `ignore-frames` are packages whose frames are passed over when looking for the crash's own code: your crash reporter or logger, which sits on every crash's stack (an unhandled-exception hook such as `com.example.app.crashreporting.CrashHandler.uncaughtException`).
- `probes` are regular expressions, matched without regard to case against the crash's exception line and message.
- `release-tags` default to `{platform}/v{version}-{build}`, then `v{version}-{build}`. `{version}` and `{build}` come from Crashlytics' name for the build, such as `1.4 (77)`, and `{platform}` is `android` or `ios`; the first pattern that names an existing tag wins. `{build}` matches digits only and `{version}` any text without spaces, so a tag such as `ios/v1.5-2026.10.29` is not read as a release, and a Crashlytics version without a build number in brackets matches no tag.
- `releases` picks the releases a run works on: `latest` (the newest tagged release, so it needs release tags), a release written as its tag (`android/v1.4-75`) or as Crashlytics names it (`1.4 (75)`), or a list of them. Without it the agent asks you each run, listing the tagged releases (`dekaput releases` prints them). A release you name when you start the run wins over the file for its app; a tag names one app's release, while a Crashlytics name applies to every app. A run nobody is watching needs it set.
- `notify` sends a short message to Discord or Slack when `open-pr` opens a pull request or the agent adds a note (`dekaput notify`). Each target names the environment variable that holds its webhook URL, so the URL stays out of the repo. A target whose variable is not set is skipped with a warning, and an alert never fails a run.
- The file can also be `de-kaput.yml` at the repo root.

## Setup

On the machine the agent runs on: steps 1 to 4 once per machine, 5 to 7 once per app repo.

1. **Install the CLI** with `npm install -g de-kaput` (Node 20 or newer). It puts `dekaput` on the PATH and installs the runbook with it, so the two always match. For the latest `main` instead of the published release, `npm install -g github:vaazh-studios/de-kaput`.
2. **Give the agent Crashlytics** through the Firebase MCP server, loaded with only the tools the runbook uses: top issues, sample events, notes, and the reports guide. Nothing that can deploy, create or change a project.
   - Claude Code: `claude mcp add firebase -- npx -y firebase-tools@latest mcp --tools crashlytics_get_report,crashlytics_batch_get_events,crashlytics_list_notes,crashlytics_create_note,firebase_read_resources` (add `-s project` to share it with your team in `.mcp.json`).
   - Codex, in `~/.codex/config.toml`:

     ```toml
     [mcp_servers.firebase]
     command = "npx"
     args = ["-y", "firebase-tools@latest", "mcp", "--tools", "crashlytics_get_report,crashlytics_batch_get_events,crashlytics_list_notes,crashlytics_create_note,firebase_read_resources"]
     ```
   - If the agent already has the full Firebase MCP server, it also has the tools that deploy and change projects, and only the runbook's rules keep it to notes. Prefer this one for de-kaput runs.
   - The agent sees what these tools return, including a crash's logs, breadcrumbs and custom keys. The runbook keeps them out of files, commits, pull requests and notes; it cannot keep them out of the agent's context.
3. **Sign in to Firebase** with `npx firebase-tools login`, as an account that can see the app's Crashlytics. Writing the `de-kaput:` notes needs write access to Crashlytics.
4. **Sign in to GitHub** with `gh auth login`, as an account that can push branches to your app's repo. `open-pr` pushes the fix branch and opens the pull request; it never pushes to the default branch.
5. **Commit `.github/de-kaput.yml`** to the default branch (see Configuration). The repo must be on GitHub with its remote named `origin`: `list` looks for de-kaput pull requests there, and `open-pr` opens them there.
6. **Tag your store releases** as `android/v1.4-75` and `ios/v1.4-77` (the default `release-tags`), or set `release-tags` to your own pattern. Tags are how de-kaput finds the commit a release was built from: Crashlytics reports a git revision for Android builds that record one (the Android Gradle plugin writes it into the build as version-control info, `vcsInfo`), and none for iOS. Without tags there is no `latest`, no list of releases to pick from, and on iOS no check for a crash that is already fixed on main. On Android with R8, keep each store release's `mapping.txt` too (the release build writes it to `app/build/outputs/mapping/release/`; for an app bundle Play Console also offers it in App bundle explorer): `list --mapping` needs the one from that exact build, and a rebuilt one names different classes.
7. **Tell the agent about de-kaput.** Both have it read the runbook with `dekaput runbook`, which prints the one installed with the CLI:
   - Claude Code: from the project's root, `mkdir -p .claude/skills && cp -R "$(npm root -g)/de-kaput/skills/de-kaput" .claude/skills/`. Commit it so the whole team's agents have it, or copy it to `~/.claude/skills/` instead to use it only yourself.
   - Codex: add one line to your project's `AGENTS.md`: "To fix a Crashlytics crash, run `dekaput runbook` and follow what it prints: one crash at a time, one pull request per crash."

The app's tests must also run on that machine: Gradle with its `local.properties`, or Xcode with an iPhone simulator.

For alerts, create an incoming webhook for the channel (Discord: Server Settings, Integrations, Webhooks; Slack: an app with Incoming Webhooks), put its URL in the environment variable your `notify` entry names, and check it with `dekaput notify --test`.

Then ask the agent to "fix the latest release's crashes with de-kaput". It reads the release's top crashes through the MCP server, runs `dekaput list`, and works through the queue one crash and one pull request at a time, as the runbook says.

**Runs nobody watches.** Any scheduler that starts your agent with a prompt can run de-kaput on its own: a scheduled task in the Claude desktop app, or cron with `claude -p` or `codex exec`. Set `releases` in the config, since nobody is there to pick one, and add `notify` to hear about notes and pull requests. Tell the agent in its prompt that nobody will answer, so where the runbook says to ask, it goes on as the runbook says for the case without an answer. The agent's own plan or API key pays for the run; de-kaput itself costs nothing. For GitHub Actions, [docs/ci.md](https://github.com/vaazh-studios/de-kaput/blob/main/docs/ci.md) has a scheduled workflow for Claude Code and one for Codex.

**What a run uses**, measured with Claude Code and Claude Opus 5.5: a run that finds nothing to fix used about 0.9M tokens in a minute, about $1 at API prices. Fixing one crash adds about 4.7M tokens on an iOS app (5 minutes, about $1.80) and 5.1M on an Android app (8 minutes, about $2.60). Over 95% of those tokens are the agent re-reading its context from the prompt cache, the cheapest kind. On a Claude plan, local runs count against the plan's usage limits, not money.

## License

Apache-2.0
