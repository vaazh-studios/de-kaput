// Alerts to Discord or Slack when a run opens a pull request or adds a
// Crashlytics note. The webhook URL is a secret, so the config names the
// environment variable that holds it, never the URL. An alert that cannot be
// sent is a warning: it never fails the run.

const MAX_LENGTH = 1900;
const PAYLOAD = {
  discord: (text) => ({ content: text }),
  slack: (text) => ({ text }),
};
export const NOTIFY_TYPES = Object.keys(PAYLOAD);

const clip = (text) => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 3)}...` : text);

export const prMessage = ({ title, url, issues, result }) =>
  clip([
    `de-kaput opened a pull request: ${title}`,
    url,
    `Crashlytics ${issues.join(', ')}: ${result === 'fixed-on-main' ? 'already fixed on main; the PR adds the test that keeps it fixed' : 'a test crashes on the base and passes with the fix'}.`,
  ].join('\n'));

export const noteMessage = ({ issue, note, uri }) =>
  clip([`de-kaput added a Crashlytics note on ${issue}:`, note, ...(uri ? [uri] : [])].join('\n'));

export const TEST_MESSAGE = 'de-kaput test alert: this channel gets a message when a run opens a pull request or adds a Crashlytics note.';

// Posts the text to every target; returns what happened to each.
export async function sendAlerts(targets, text, { env = process.env, fetchFn = fetch, warn = (line) => console.error(`dekaput: ${line}`) } = {}) {
  const results = [];
  for (const { type, webhookEnv } of targets) {
    const url = env[webhookEnv];
    if (!url) {
      warn(`${type} alert skipped: ${webhookEnv} is not set`);
      results.push({ type, sent: false });
      continue;
    }
    try {
      const response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(PAYLOAD[type](text)) });
      if (!response.ok) warn(`${type} alert failed: HTTP ${response.status}`);
      results.push({ type, sent: response.ok });
    } catch (error) {
      warn(`${type} alert failed: ${error.message}`);
      results.push({ type, sent: false });
    }
  }
  return results;
}
