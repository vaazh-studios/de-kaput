# One crash, end to end

**Goal:** one real crash goes from Crashlytics to a normal pull request that contains its reproduction test, with the proof in the PR. Configuration comes after this works (founder, 2026-10-28: "first make the flow work for one crash then we will work on how to configure it").

**First crash:** Vocabloot's `currentTab` crash (Crashlytics e044059c and f26e8107, Android 1.4 (75)), the latest release's top crash and the only one real users hit. It is already fixed on main by d3d87191 but not released, so this run ends in a PR that adds the reproduction test: it crashes on the 1.4 (75) commit (849c6d7a) and passes on main.

**Where it comes from:** a working prototype inside Vocabloot (`.claude/skills/crash-fix/` on vaazh-studios/snaplingo main; plan `docs/superpowers/plans/2026-10-27-crash-fix-agent.md` there). This plan ports the parts the one-crash flow needs and leaves the rest.

## The flow

1. The agent (Codex or Claude Code) reads the latest release's top 10 fatal crashes from Crashlytics with the Firebase MCP server and saves each as an event file (allowlisted fields only).
2. `dekaput list .dekaput/events/*.json` ranks them by users affected, marks the ones that already have a PR or a note, and names the next one to work on, with its anchor and release ref.
3. The agent works only on that crash, in its own worktree cut from the default branch: test first, then the fix (none when it is already fixed on main), committed.
4. `dekaput verify` runs the test on the merge base (must fail with the crash's exception, reaching the anchor, thrown from app code), then on HEAD and the module's suite (must pass); when it passes on the base it runs on the release ref (must crash there: `fixed-on-main`). It writes a receipt bound to HEAD, the base and the diff hash.
5. `dekaput open-pr` checks the receipt still matches the branch, pushes it, and opens a normal PR with the test, the fix if any, and the proof. Then the agent adds a Crashlytics note linking the PR.

Inputs are command-line flags for now (module, test filter, exception, anchor, release ref). A config file is the next step after this plan.

## Tasks

1. **Package and proof rules.** `package.json` (Node 20+, ESM, `bin`: `dekaput` and `de-kaput`), `src/proof.mjs` ported with its tests (anchor matching, self-thrown check, diff rules, JUnit parsing). `node --test` green.
2. **verify with the Gradle runner.** `src/verify.mjs` and `src/runners/gradle.mjs` ported: throwaway worktrees for the base and the release, `local.properties` copied from the main checkout, real re-runs (`--rerun`, no build cache), receipt written to `.dekaput/receipts/<HEAD>.json`. Checked on a throwaway branch with a planted bug in a small module, as the prototype was.
3. **list.** `src/list.mjs` with the prototype's classification, release tags and redacted evidence; fatal crashes only, ranked by impacted users; "already handled" from `gh pr list` with the `de-kaput` label and from the event's notes.
4. **open-pr.** `src/open-pr.mjs`: refuses unless the receipt is `proven` or `fixed-on-main`, its head is HEAD, its base is still the merge base and its diff hash matches; pushes; `gh pr create` (not a draft) with the label `de-kaput` and a body from the receipt and the evidence.
5. **Runbook.** `RUNBOOK.md`: the run order above, written for any agent, with a short `AGENTS.md` note for Codex and a Claude Code skill that points at it.
6. **First run.** On vaazh-studios/snaplingo, the `currentTab` crash, with the existing `RestoredTabSlotTest`, ending in a PR there. Record what happened below.

## Not in this plan

Config file, Xcode and SwiftPM runners, the GitHub check that re-runs the proof in CI, bisect, the 3/3 and 5/5 repeat runs, scheduled runs, other crash sources.

## First run (2026-10-28)

**Result: vaazh-studios/snaplingo#17**, a normal PR labelled `de-kaput` that adds `RestoredTabSlotTest`, with the proof in its body and a `de-kaput:` note on both Crashlytics issues. `list` then reports the crash handled and nothing left on the release.

What the run did:

1. Latest release: Android 1.4 (75) (48 users). Crashlytics lists versions by event count and includes internal builds (1.4 (77), 6 users), so "latest" means the newest released version, not the first row.
2. That release has one fatal crash, f26e8107 (2 users). Its message names the Words tab only by its R8 name (`Key sm8:currentTab ...`), so the first `list` saw no app code and skipped it.
3. A rebuilt R8 mapping for the release commit did not match the shipped build (in it `sm8` is an unrelated inner class, the tab is `wm8`), so rebuilding is not a way to read R8 names. `list` now anchors on the message's own words when a class has only its R8 name ("currentTab was used multiple times"); searching the repo for them finds the one place that writes the key, `TabContentSlot.kt`. `--mapping` stays for teams that archive the release's mapping.
4. `verify`: the test passes on main and crashes on the release commit with the production message, the real class name included. `fixed-on-main` in 1 min 26 s; keeping the compile cache (only `--rerun` on the test task) took it from 1 h 24 min in the prototype.
5. `open-pr` first pushed the commit to snaplingo's `main` instead of a branch: `push.default=upstream` and a branch cut from `origin/main` that tracked it. Reverted on main (62ee56b0), fixed in `open-pr` (the push names `refs/heads/<branch>` and refuses the default branch, tested against that exact git setup) and in the runbook (`--no-track`), then the same test went out as #17.

Fixed along the way: the proof section's wording for message-text anchors and for test-only PRs.

Next: configuration (app id, packages, Gradle task, release refs in one file), then the Xcode runner.
