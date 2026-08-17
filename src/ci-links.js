/*
 * Getting from a CI job to the Cypress Cloud run it recorded.
 *
 * Cypress prints its run URL into the job log, so the whole problem is: fetch
 * the log, find the URL. The fiddly parts are that CI logs are ANSI-coloured
 * (the escape codes land *inside* the URL match) and that a log usually mentions
 * the run several times in slightly different forms.
 */

const { execFile } = require('child_process');

// Strip ANSI SGR/CSI sequences. Without this, a match off a GitLab trace comes
// back as `https://cloud.cypress.io/projects/6b9ofw/runs/12906[0m` — a URL
// that looks right in a log and 404s in a browser.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

// `(?:\/…)*` — repeated, not optional-once: a replay link carries several path
// segments after the run id (`/test-results/<uuid>/replay`), and matching only
// the first truncates it to the test-results page, silently discarding exactly
// the specificity that makes a replay link worth preferring.
const RUN_URL = /https?:\/\/cloud\.cypress\.io\/projects\/[A-Za-z0-9]+\/runs\/\d+(?:\/[A-Za-z0-9._-]+)*(?:\?[^\s"'<>)\]]*)?/g;

/*
 * Pull every Cypress Cloud run URL out of a blob of log text, best first.
 *
 * "Best" means the most specific: a link to a particular test's replay beats a
 * link to the run overview, because it needs no further navigation. Trailing
 * punctuation is trimmed — logs habitually wrap URLs in parentheses or end a
 * sentence with one.
 */
function extractRunUrls(text) {
  if (!text) return [];
  const clean = stripAnsi(text);
  const seen = new Map();
  for (const raw of clean.match(RUN_URL) || []) {
    const url = raw.replace(/[.,;:)\]}'"]+$/, '');
    if (!seen.has(url)) seen.set(url, score(url));
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([url]) => url);
}

function score(url) {
  if (/\/replay/.test(url)) return 3;
  if (/\/test-results/.test(url)) return 2;
  if (/\/overview/.test(url)) return 0;
  return 1;
}

/*
 * Parse a GitLab job URL into the pieces the API needs.
 *
 * Handles nested groups (`group/sub/project`), self-hosted hosts, and the
 * `/-/jobs/<id>` separator GitLab uses. The project path must be URL-encoded
 * whole (slashes included) for the v4 API.
 */
function parseGitlabJobUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return { error: 'not-a-url', url }; }
  const m = u.pathname.match(/^\/(.+?)\/-\/jobs\/(\d+)/);
  if (!m) return { error: 'not-a-gitlab-job-url', url: String(url) };
  return { host: u.origin, projectPath: m[1], jobId: m[2], encodedProject: encodeURIComponent(m[1]) };
}

function run(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/*
 * Fetch a GitLab job's log via the `glab` CLI.
 *
 * `glab` rather than a raw token: it is what the user already has authenticated
 * (including for self-hosted hosts), so there is no second credential for this
 * tool to store, prompt for, or leak. It is an OPTIONAL dependency — every
 * failure below is reported with the exact command to fix it, because "no
 * output" from an auth problem is otherwise indistinguishable from "this job
 * never ran Cypress".
 */
async function fetchGitlabJobTrace(jobUrl, { glabBin = 'glab', timeoutMs = 60000 } = {}) {
  const parsed = parseGitlabJobUrl(jobUrl);
  if (parsed.error) {
    return {
      ...parsed,
      hint: 'Expected a GitLab job URL like https://gitlab.com/group/project/-/jobs/12345678',
    };
  }

  const which = await run('sh', ['-c', `command -v ${glabBin}`]);
  if (which.err || !which.stdout.trim()) {
    return {
      error: 'glab-not-found',
      hint: 'The `glab` CLI is required to read CI job logs. Install it (`brew install glab`) and run `glab auth login`. Alternatively, fetch the job log yourself and pass the text to `cloud_open_run { text }`.',
    };
  }

  const args = ['api', `projects/${parsed.encodedProject}/jobs/${parsed.jobId}/trace`];
  if (parsed.host && !/^https:\/\/gitlab\.com$/.test(parsed.host)) {
    args.push('--hostname', new URL(parsed.host).host);
  }
  const res = await run(glabBin, args, { timeoutMs });
  if (res.err || !res.stdout) {
    const msg = (res.stderr || res.err?.message || '').trim();
    const isAuth = /401|403|unauthor|authent|not logged in|token/i.test(msg);
    return {
      error: isAuth ? 'glab-not-authenticated' : 'glab-failed',
      job: { projectPath: parsed.projectPath, jobId: parsed.jobId },
      stderr: msg.slice(0, 500),
      hint: isAuth
        ? 'Run `glab auth login` (and check you can see this project).'
        : `\`${glabBin} ${args.join(' ')}\` failed. Check the job URL and that you have access to that project.`,
    };
  }
  return { ok: true, job: { projectPath: parsed.projectPath, jobId: parsed.jobId }, trace: res.stdout };
}

/*
 * A GitLab job URL in, a Cypress Cloud run URL out.
 */
async function findRunUrlForCiJob(jobUrl, opts = {}) {
  const traced = await fetchGitlabJobTrace(jobUrl, opts);
  if (traced.error) return traced;
  const urls = extractRunUrls(traced.trace);
  if (!urls.length) {
    return {
      error: 'no-cypress-url-in-log',
      job: traced.job,
      traceBytes: traced.trace.length,
      hint: 'The job log contains no cloud.cypress.io run URL. Either this job did not run Cypress with recording enabled (`--record`), or the log has been expired/truncated by GitLab.',
    };
  }
  return { ok: true, job: traced.job, url: urls[0], allUrls: urls, traceBytes: traced.trace.length };
}

module.exports = {
  stripAnsi,
  extractRunUrls,
  parseGitlabJobUrl,
  fetchGitlabJobTrace,
  findRunUrlForCiJob,
};
