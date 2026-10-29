// The project config: .github/de-kaput.yml (next to dependabot.yml), or
// de-kaput.yml at the repo root. Everything app-specific lives here, so the
// commands need no flags. Flags still win over the file.
//
//   version: 1
//   open-pull-requests-limit: 5        # optional, like Dependabot's
//   reviewers: [octocat]               # optional, asked to review every PR
//   notify:                            # optional: alerts when a PR opens or a note is added
//     - type: discord                  # discord | slack
//       webhook-env: DEKAPUT_DISCORD_WEBHOOK   # the environment variable holding the webhook URL
//   apps:
//     - name: android                  # optional, defaults to the platform
//       platform: android              # android | ios
//       crashlytics-app-id: "1:123:android:abc"
//       packages: [com.example.app]    # the app's own code (Kotlin and Java; optional for ios)
//       ignore-frames: [com.example.app.crashreporting]   # its own crash reporter
//       probes: ["crash-reporting canary"]                # errors it raises on purpose
//       release-tags: ["{platform}/v{version}-{build}"]   # optional: only when tags found by name are ambiguous
//       releases: latest               # optional: latest, all, a release (tag, "1.4 (77)" or "1.4"), or a list; without it the agent asks
//       modules:                      # where tests live, and what runs them
//         - path: shared/presentation
//           gradle-task: ":shared:presentation:testAndroidHostTest"
//         - path: ios                  # "." for the repo root
//           xcode-scheme: App
//           xcode-workspace: App.xcworkspace   # or xcode-project; neither for a Swift package (relative to path)
//           xcode-destination: "platform=iOS Simulator,name=iPhone 17"   # optional; "platform=macOS" for tests that run on the Mac
//           xcode-args: ["CODE_SIGNING_ALLOWED=NO", "-testPlan", "AppTests"]   # optional, what the project's CI passes

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { NOTIFY_TYPES } from './notify.mjs';

export const CONFIG_FILES = ['.github/de-kaput.yml', 'de-kaput.yml'];
const PLATFORMS = ['android', 'ios'];
const TOP_KEYS = ['version', 'open-pull-requests-limit', 'reviewers', 'notify', 'apps'];
const NOTIFY_KEYS = ['type', 'webhook-env'];
const APP_KEYS = ['name', 'platform', 'crashlytics-app-id', 'packages', 'ignore-frames', 'probes', 'release-tags', 'releases', 'modules'];
const XCODE_KEYS = ['xcode-scheme', 'xcode-workspace', 'xcode-project', 'xcode-destination', 'xcode-args'];
const MODULE_KEYS = ['path', 'gradle-task', ...XCODE_KEYS];

class ConfigError extends Error {}
const fail = (where, message) => {
  throw new ConfigError(`de-kaput config${where ? ` (${where})` : ''}: ${message}`);
};

function onlyKnown(object, keys, where) {
  for (const key of Object.keys(object ?? {})) if (!keys.includes(key)) fail(where, `unknown key "${key}"`);
}

const stringList = (value, key, where, { required = false } = {}) => {
  if (value === undefined) {
    if (required) fail(where, `"${key}" is required`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) fail(where, `"${key}" must be a list of strings`);
  if (required && value.length === 0) fail(where, `"${key}" must not be empty`);
  return value;
};

export function parseConfig(text) {
  const raw = parse(text) ?? {};
  onlyKnown(raw, TOP_KEYS, null);
  if (raw.version !== 1) fail(null, 'only version 1 exists; start the file with "version: 1"');
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) fail(null, '"apps" must list at least one app');
  const limit = raw['open-pull-requests-limit'] ?? 5;
  if (!Number.isInteger(limit) || limit < 0) fail(null, '"open-pull-requests-limit" must be a whole number, 0 or more');

  const apps = raw.apps.map((app, i) => {
    const where = `apps[${i}]`;
    onlyKnown(app, APP_KEYS, where);
    if (!PLATFORMS.includes(app.platform)) fail(where, `"platform" must be one of ${PLATFORMS.join(', ')}`);
    if (typeof app['crashlytics-app-id'] !== 'string' || !app['crashlytics-app-id']) fail(where, '"crashlytics-app-id" is required');
    const modules = (app.modules ?? []).map((m, j) => {
      const mWhere = `${where}.modules[${j}]`;
      onlyKnown(m, MODULE_KEYS, mWhere);
      if (typeof m.path !== 'string' || !m.path) fail(mWhere, '"path" is required');
      const dir = m.path.replace(/\/+$/, '');
      const root = dir === '.' ? '' : dir;
      if ((m['gradle-task'] === undefined) === (m['xcode-scheme'] === undefined)) fail(mWhere, 'give "gradle-task" (Gradle) or "xcode-scheme" (Xcode), one of the two');
      if (m['gradle-task'] !== undefined) {
        if (typeof m['gradle-task'] !== 'string' || !m['gradle-task'].startsWith(':')) fail(mWhere, '"gradle-task" must be a task path such as ":app:testDebugUnitTest"');
        if (XCODE_KEYS.some((k) => m[k] !== undefined)) fail(mWhere, 'the xcode-* keys need "xcode-scheme", not "gradle-task"');
        return { path: root, gradleTask: m['gradle-task'] };
      }
      for (const key of XCODE_KEYS.filter((k) => k !== 'xcode-args')) {
        if (m[key] !== undefined && (typeof m[key] !== 'string' || !m[key])) fail(mWhere, `"${key}" must be a name or path`);
      }
      if (m['xcode-workspace'] && m['xcode-project']) fail(mWhere, '"xcode-workspace" or "xcode-project", not both');
      const xcode = {
        scheme: m['xcode-scheme'],
        workspace: m['xcode-workspace'] ?? null,
        project: m['xcode-project'] ?? null,
        destination: m['xcode-destination'] ?? null,
        args: stringList(m['xcode-args'], 'xcode-args', mWhere),
      };
      return { path: root, xcode };
    });
    return {
      name: app.name ?? app.platform,
      platform: app.platform,
      crashlyticsAppId: app['crashlytics-app-id'],
      // A native iOS app's own code is its Swift and Objective-C files in the repo; packages name Kotlin code.
      packages: stringList(app.packages, 'packages', where, { required: app.platform === 'android' }),
      ignoreFrames: stringList(app['ignore-frames'], 'ignore-frames', where),
      probes: stringList(app.probes, 'probes', where),
      // null: tags are found by name; patterns only for a repo whose names are ambiguous.
      releaseTags: app['release-tags'] === undefined ? null : releaseTags(app['release-tags'], where),
      // null: the config does not say, so the agent asks the person which release.
      releases: app.releases === undefined ? null : stringList(typeof app.releases === 'string' ? [app.releases] : app.releases, 'releases', where, { required: true }),
      modules,
    };
  });
  return { openPullRequestsLimit: limit, reviewers: stringList(raw.reviewers, 'reviewers', null), notify: notifyTargets(raw.notify), apps };
}

// Tag patterns; {build} is optional, but nothing can be read back from a tag without {version}.
function releaseTags(value, where) {
  const patterns = stringList(value, 'release-tags', where);
  if (!patterns.every((p) => p.includes('{version}'))) fail(where, '"release-tags" patterns need {version}, such as "v{version}" or "{platform}/v{version}-{build}"');
  return patterns;
}

// Where alerts go: each target names the environment variable that holds its webhook URL, never the URL.
function notifyTargets(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(null, '"notify" must be a list, such as [{type: discord, webhook-env: DEKAPUT_DISCORD_WEBHOOK}]');
  return value.map((target, i) => {
    const where = `notify[${i}]`;
    onlyKnown(target, NOTIFY_KEYS, where);
    if (!NOTIFY_TYPES.includes(target.type)) fail(where, `"type" must be one of ${NOTIFY_TYPES.join(', ')}`);
    if (typeof target['webhook-env'] !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(target['webhook-env'])) {
      fail(where, '"webhook-env" must name an environment variable, such as DEKAPUT_DISCORD_WEBHOOK (never the webhook URL itself)');
    }
    return { type: target.type, webhookEnv: target['webhook-env'] };
  });
}

export function loadConfig(root) {
  for (const file of CONFIG_FILES) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) {
      try {
        return { ...parseConfig(fs.readFileSync(full, 'utf8')), file };
      } catch (error) {
        throw new ConfigError(`${file}: ${error.message}`);
      }
    }
  }
  return null;
}

// The app a crash belongs to: the one named, or the first for the crash's platform.
export function appFor(config, platform, name) {
  if (name) return config.apps.find((a) => a.name === name) ?? fail(null, `no app named "${name}"`);
  return config.apps.find((a) => a.platform === platform.toLowerCase()) ?? null;
}

// The app's options for list, from the config.
export const listOptions = (app) => ({
  appPackages: app.packages,
  ignoreFrames: app.ignoreFrames,
  probes: app.probes.map((p) => new RegExp(p, 'i')),
  releaseTags: app.releaseTags,
});

const moduleName = (m) => m.path || '.';

// The module for the branch's tests, looked up across every app's modules.
export function moduleForAnyApp(config, testFiles) {
  const found = [...new Set(config.apps.map((a) => moduleFor(a, testFiles)).filter(Boolean))];
  const runs = new Set(found.map((m) => m.gradleTask ?? `${m.path}:${m.xcode.scheme}`));
  if (runs.size > 1) fail(null, `the branch's tests match more than one module (${found.map(moduleName).join(', ')}); keep them in one, or pass --gradle-task`);
  return found[0] ?? null;
}

// The module holding the branch's test files; the longest matching path wins.
export function moduleFor(app, testFiles) {
  const holds = (m, file) => m.path === '' || file === m.path || file.startsWith(`${m.path}/`);
  const owner = (file) => [...app.modules].sort((a, b) => b.path.length - a.path.length).find((m) => holds(m, file));
  const owners = [...new Set(testFiles.map(owner).filter(Boolean))];
  if (owners.length > 1) fail(null, `the branch's tests are in two modules (${owners.map(moduleName).join(', ')}); keep them in one, or pass --gradle-task`);
  return owners[0] ?? null;
}

export { ConfigError };
