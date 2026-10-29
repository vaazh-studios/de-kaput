# Setup

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
5. **Commit `.github/de-kaput.yml`** to the default branch (see [Configuration](configuration.md)). The repo must be on GitHub with its remote named `origin`: `list` looks for de-kaput pull requests there, and `open-pr` opens them there.
6. **Tag your store releases** as `android/v1.4-75` and `ios/v1.4-77` (the default `release-tags`), or set `release-tags` to your own pattern. Tags are how de-kaput finds the commit a release was built from: Crashlytics reports a git revision for Android builds that record one (the Android Gradle plugin writes it into the build as version-control info, `vcsInfo`), and none for iOS. Without tags there is no `latest`, no list of releases to pick from, and on iOS no check for a crash that is already fixed on main. On Android with R8, keep each store release's `mapping.txt` too (the release build writes it to `app/build/outputs/mapping/release/`; for an app bundle Play Console also offers it in App bundle explorer): `list --mapping` needs the one from that exact build, and a rebuilt one names different classes.
7. **Tell the agent about de-kaput.** Both have it read the runbook with `dekaput runbook`, which prints the one installed with the CLI:
   - Claude Code: from the project's root, `mkdir -p .claude/skills && cp -R "$(npm root -g)/de-kaput/skills/de-kaput" .claude/skills/`. Commit it so the whole team's agents have it, or copy it to `~/.claude/skills/` instead to use it only yourself.
   - Codex: add one line to your project's `AGENTS.md`: "To fix a Crashlytics crash, run `dekaput runbook` and follow what it prints: one crash at a time, one pull request per crash."

The app's tests must also run on that machine: Gradle with its `local.properties`, or Xcode with an iPhone simulator.

Then ask the agent to "fix the latest release's crashes with de-kaput". It reads the release's top crashes through the MCP server, runs `dekaput list`, and works through the queue one crash and one pull request at a time, as the runbook says.

## Alerts

For alerts, create an incoming webhook for the channel (Discord: Server Settings, Integrations, Webhooks; Slack: an app with Incoming Webhooks), put its URL in the environment variable your `notify` entry names, and check it with `dekaput notify --test`.

## Runs nobody watches

Any scheduler that starts your agent with a prompt can run de-kaput on its own: a scheduled task in the Claude desktop app, or cron with `claude -p` or `codex exec`. Set `releases` in the config, since nobody is there to pick one, and add `notify` to hear about notes and pull requests. Tell the agent in its prompt that nobody will answer, so where the runbook says to ask, it goes on as the runbook says for the case without an answer. The agent's own plan or API key pays for the run; de-kaput itself costs nothing. For GitHub Actions, [ci.md](ci.md) has a scheduled workflow for Claude Code and one for Codex.

## Platforms

Built for native Android, native iOS and Kotlin Multiplatform apps: Gradle runs the JVM tests, and `xcodebuild` runs XCTest and Swift Testing on an iPhone simulator (Xcode 16 or newer). On iOS a crash's identity is its Mach exception or signal (`EXC_BREAKPOINT`, `EXC_BAD_ACCESS`, `SIGABRT`) or its NSException name, read from the crash log the simulator writes. On iOS, a crash in Kotlin/Native gets a note instead: an unhandled Kotlin exception aborts without its message in the report, whether the code is in `commonMain` or `iosMain`, and a crash in a native source set cannot run on the JVM. There is no Kotlin/Native runner yet.
