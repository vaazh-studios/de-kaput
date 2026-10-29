---
name: de-kaput
description: Use when asked to fix a Crashlytics crash, work on the latest release's top crashes, or run de-kaput. Works through the release's crashes one at a time, one pull request per crash: reproduce each with a test first, prove it, then open its pull request.
---

Follow the de-kaput runbook exactly, in order, for each crash in the queue. It is installed with the `dekaput` CLI, so it matches the CLI's version: read `$(npm root -g)/@vaazh-studios/de-kaput/RUNBOOK.md`. If `dekaput` is not on the PATH, stop and ask the user to install it with `npm install -g github:vaazh-studios/de-kaput` (Setup in the de-kaput README). Never merge, never fix without a test that reproduces the crash first.
