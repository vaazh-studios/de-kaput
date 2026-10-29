# Running de-kaput on a schedule in GitHub Actions

A recipe for running the de-kaput runbook from a scheduled GitHub Actions job, with Claude Code or Codex as the agent. The maintainers haven't run these workflows yet, so treat them as a starting point and adjust them to your app's own CI. Each run is billed to your Anthropic or OpenAI API account and uses your CI minutes; de-kaput itself costs nothing.

## Before the first run

- **`.github/de-kaput.yml`** sets `releases` for every app (nobody is there to pick one) and, for alerts, `notify` (see [Configuration](configuration.md)).
- **Secrets** in the repo's Actions settings:
  - `ANTHROPIC_API_KEY` (Claude Code) or `OPENAI_API_KEY` (Codex).
  - `FIREBASE_SERVICE_ACCOUNT`: the JSON key of a Google service account that can read the app's Crashlytics and add notes. Prefer a dedicated account with only those permissions; `google-github-actions/auth` also supports Workload Identity Federation, which needs no key.
  - The webhook URL your `notify` entry names, such as `DEKAPUT_DISCORD_WEBHOOK`, if you use alerts.
- **The runner** can build your tests: Ubuntu for Gradle (GitHub's Ubuntu images include the Android SDK), macOS for Xcode (it includes Xcode, and its minutes cost more).

Scheduled workflows run only from the default branch, so the prompt and the config come from code you reviewed. Don't start this job from `pull_request` events.

## Claude Code

```yaml
name: de-kaput
on:
  schedule:
    - cron: "0 8 * * *" # every day, 08:00 UTC
  workflow_dispatch:

permissions:
  contents: write # push the fix branches
  pull-requests: write # open the pull requests
  issues: write # create the de-kaput label
  id-token: write

jobs:
  crashes:
    runs-on: ubuntu-latest # macos-latest for an Xcode app
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
      - name: Install de-kaput and sign gh in
        run: |
          npm install -g de-kaput firebase-tools
          echo "${{ github.token }}" | gh auth login --with-token
      - name: Firebase MCP server, Crashlytics tools only
        run: |
          cat > "$RUNNER_TEMP/mcp.json" <<EOF
          {"mcpServers": {"firebase": {
            "command": "firebase",
            "args": ["mcp", "--tools", "crashlytics_get_report,crashlytics_batch_get_events,crashlytics_list_notes,crashlytics_create_note,firebase_read_resources"],
            "env": {"GOOGLE_APPLICATION_CREDENTIALS": "$GOOGLE_APPLICATION_CREDENTIALS"}
          }}}
          EOF
      - uses: anthropics/claude-code-action@v1
        env:
          DEKAPUT_DISCORD_WEBHOOK: ${{ secrets.DEKAPUT_DISCORD_WEBHOOK }}
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Fix the latest release's crashes with de-kaput: run `dekaput runbook` and follow what it prints exactly, in order.
            Nobody will answer questions in this run. Where the runbook says to ask the person, go on as it says for the case
            without an answer, and list it in the summary. Never merge a pull request. End with the runbook's summary.
          claude_args: >-
            --mcp-config ${{ runner.temp }}/mcp.json
            --allowedTools "Read,Write,Edit,Glob,Grep,Bash,mcp__firebase__crashlytics_get_report,mcp__firebase__crashlytics_batch_get_events,mcp__firebase__crashlytics_list_notes,mcp__firebase__crashlytics_create_note,mcp__firebase__firebase_read_resources"
```

## Codex

```yaml
name: de-kaput
on:
  schedule:
    - cron: "0 8 * * *" # every day, 08:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  crashes:
    runs-on: ubuntu-latest # macos-latest for an Xcode app
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
      - name: Install de-kaput and sign gh in
        run: |
          npm install -g de-kaput firebase-tools
          echo "${{ github.token }}" | gh auth login --with-token
      - name: Codex home with the Firebase MCP server
        run: |
          mkdir -p "$RUNNER_TEMP/codex-home"
          cat > "$RUNNER_TEMP/codex-home/config.toml" <<EOF
          # Nobody is there to approve anything; the runbook's rules bound the run.
          approval_policy = "never"

          [mcp_servers.firebase]
          command = "firebase"
          args = ["mcp", "--tools", "crashlytics_get_report,crashlytics_batch_get_events,crashlytics_list_notes,crashlytics_create_note,firebase_read_resources"]
          env = { GOOGLE_APPLICATION_CREDENTIALS = "$GOOGLE_APPLICATION_CREDENTIALS" }
          startup_timeout_sec = 60 # the default is 10
          required = true # fail the run instead of going on without Crashlytics
          default_tools_approval_mode = "auto" # run the five tools without asking
          EOF
      - uses: openai/codex-action@v1
        env:
          DEKAPUT_DISCORD_WEBHOOK: ${{ secrets.DEKAPUT_DISCORD_WEBHOOK }}
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          codex-home: ${{ runner.temp }}/codex-home
          # The runbook needs the network (Gradle, git push, gh, the MCP server); the default :workspace profile has none.
          sandbox: danger-full-access
          prompt: |
            Fix the latest release's crashes with de-kaput: run `dekaput runbook` and follow what it prints exactly, in order.
            Nobody will answer questions in this run. Where the runbook says to ask the person, go on as it says for the case
            without an answer, and list it in the summary. Never merge a pull request. End with the runbook's summary.
```

## Notes

- **Pull request checks:** pull requests opened with the workflow's `GITHUB_TOKEN` don't start other workflows, so your PR checks won't run on them. To have them run, sign `gh` in with a fine-grained token or a GitHub App token instead.
- **Tool access:** the Claude Code example allows all of `Bash`, since the runbook runs git, Gradle or `xcodebuild`, `gh` and `dekaput`. You can narrow it, for example to `Bash(dekaput:*),Bash(git:*),Bash(gh:*),Bash(./gradlew:*)`.
- **Starting the Firebase server:** both workflows install `firebase-tools` in an earlier step and start it as `firebase mcp`. Fetching it with `npx` at startup can outlast an agent's MCP startup timeout (Codex waits 10 seconds by default).
- **Codex approvals:** the `config.toml` above sets `approval_policy = "never"` and `default_tools_approval_mode = "auto"` on the Firebase server, so nothing waits for a person. If a run reports a Crashlytics call as rejected, check those two settings against your Codex version.
- **R8 mapping:** a step before the agent can download the release build's `mapping.txt` from wherever your release job keeps it, and the prompt can name its path for `list --mapping`.
- **One run, one queue:** `open-pull-requests-limit` caps open de-kaput PRs across runs, and a crash with a de-kaput PR or note is never picked up again, so a daily schedule doesn't pile up duplicates.
