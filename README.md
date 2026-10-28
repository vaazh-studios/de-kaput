# de-kaput

Your app went kaput. de-kaput reproduces the crash with a test, fixes it, and opens a pull request with the test and the fix.

It never fixes blind: no pull request without a test that fails with the crash's own exception before the fix and passes after it. A person always reviews and merges.

> **Status: early.** The first goal is one crash going end to end, from Crashlytics to a pull request with its test. Configuration comes after that.

## How it works

![de-kaput: dekaput list queues the release's crashes; for each crash, one at a time: its commit, a new git worktree, a test that crashes, dekaput verify, dekaput open-pr; one pull request per crash](assets/how-it-works.svg)

1. Your coding agent (Codex or Claude Code) reads the latest release's top crashes from Crashlytics through the Firebase MCP server.
2. `dekaput list` skips crashes that already have a pull request and puts the rest in a queue.
3. **For each crash in the queue, one at a time**, like Dependabot does for each dependency:
   - it finds the commit that crash was built from: the git revision Crashlytics recorded for the build, or your release tag;
   - the agent checks out a new git worktree on a fresh branch from your default branch, so your own checkout is never touched, and writes a test that reproduces the crash, then fixes it;
   - `dekaput verify` proves it in throwaway worktrees: the test fails on your default branch with the crash's exception, reaching the crash's code, and passes with the fix, with the module's tests green. If the test already passes on your default branch, it runs on the crash's commit instead; crashing there means the crash is already fixed and not yet shipped;
   - `dekaput open-pr` refuses without that proof, then opens a pull request for that crash with the test, the fix and the proof.
   A crash no test can reach gets a note on the Crashlytics issue instead, and the run moves on.
4. You get **one pull request per crash**, each reviewed and merged on its own. `--max-prs` caps how many are open at once.

Built for native Android, native iOS and Kotlin Multiplatform apps. Gradle first; Xcode next.

## Use it with your agent

- **Claude Code:** copy `skills/de-kaput/` into your project's `.claude/skills/`, then ask "fix the next crash with de-kaput".
- **Codex:** add one line to your project's `AGENTS.md`: "To fix a Crashlytics crash, follow RUNBOOK.md from vaazh-studios/de-kaput, one crash per run."

Until the npm package is published, run the CLI from a clone: `node <clone>/bin/dekaput.mjs` in place of `npx @vaazh-studios/de-kaput`.

## License

Apache-2.0
