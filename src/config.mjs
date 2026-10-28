// The project config: .github/de-kaput.yml (next to dependabot.yml), or
// de-kaput.yml at the repo root. Everything app-specific lives here, so the
// commands need no flags. Flags still win over the file.
//
//   version: 1
//   open-pull-requests-limit: 5        # optional, like Dependabot's
//   reviewers: [octocat]               # optional, asked to review every PR
//   apps:
//     - name: android                  # optional, defaults to the platform
//       platform: android              # android | ios
//       crashlytics-app-id: "1:123:android:abc"
//       packages: [com.example.app]    # the app's own code
//       ignore-frames: [com.example.app.crashreporting]   # its own crash reporter
//       probes: ["crash-reporting canary"]                # errors it raises on purpose
//       release-tags: ["{platform}/v{version}-{build}", "v{version}-{build}"]
//       modules:                       # where tests live, and the task that runs them
//         - path: shared/presentation
//           gradle-task: ":shared:presentation:testAndroidHostTest"

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const CONFIG_FILES = ['.github/de-kaput.yml', 'de-kaput.yml'];
export const DEFAULT_RELEASE_TAGS = ['{platform}/v{version}-{build}', 'v{version}-{build}'];
const PLATFORMS = ['android', 'ios'];
const TOP_KEYS = ['version', 'open-pull-requests-limit', 'reviewers', 'apps'];
const APP_KEYS = ['name', 'platform', 'crashlytics-app-id', 'packages', 'ignore-frames', 'probes', 'release-tags', 'modules'];
const MODULE_KEYS = ['path', 'gradle-task'];

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
      if (typeof m['gradle-task'] !== 'string' || !m['gradle-task'].startsWith(':')) fail(mWhere, '"gradle-task" must be a task path such as ":app:testDebugUnitTest"');
      return { path: m.path.replace(/\/+$/, ''), gradleTask: m['gradle-task'] };
    });
    return {
      name: app.name ?? app.platform,
      platform: app.platform,
      crashlyticsAppId: app['crashlytics-app-id'],
      packages: stringList(app.packages, 'packages', where, { required: true }),
      ignoreFrames: stringList(app['ignore-frames'], 'ignore-frames', where),
      probes: stringList(app.probes, 'probes', where),
      releaseTags: app['release-tags'] === undefined ? DEFAULT_RELEASE_TAGS : stringList(app['release-tags'], 'release-tags', where),
      modules,
    };
  });
  return { openPullRequestsLimit: limit, reviewers: stringList(raw.reviewers, 'reviewers', null), apps };
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

// The Gradle task for the branch's tests, looked up across every app's modules.
export function taskForAnyApp(config, testFiles) {
  const tasks = [...new Set(config.apps.map((a) => taskFor(a, testFiles)).filter(Boolean))];
  if (tasks.length > 1) fail(null, `the branch's tests match more than one module (${tasks.join(', ')}); pass --gradle-task`);
  return tasks[0] ?? null;
}

// The Gradle task for the module holding the branch's test files; the longest matching path wins.
export function taskFor(app, testFiles) {
  const owner = (file) => [...app.modules].sort((a, b) => b.path.length - a.path.length).find((m) => file === m.path || file.startsWith(`${m.path}/`));
  const owners = [...new Set(testFiles.map(owner).filter(Boolean))];
  if (owners.length > 1) fail(null, `the branch's tests are in two modules (${owners.map((m) => m.path).join(', ')}); pass --gradle-task`);
  return owners[0]?.gradleTask ?? null;
}

export { ConfigError };
