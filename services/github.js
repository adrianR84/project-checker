// GitHub API service — token is read from config DB (no env var needed)
const GITHUB_API = 'https://api.github.com';

/** Returns request headers for the GitHub API, including auth token from DB if set. */
async function ghHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'project-checker',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  // Lazy-load token from DB on each request to avoid init-order issues
  const db = require('./db');
  const settings = await db.config.getSettings();
  if (settings?.github_token) {
    headers['Authorization'] = `Bearer ${settings.github_token}`;
  }
  return headers;
}

// Parse owner from various GitHub URL formats
/** Extracts the GitHub org/user from any common GitHub URL format. */
function parseOwner(githubUrl) {
  if (!githubUrl) return null;
  const match = githubUrl.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s?#]+)/i);
  return match ? match[1] : null;
}

/** Fetches a GitHub API URL and returns parsed JSON, throwing on errors. */
async function ghFetch(url) {
  const res = await fetch(url, { headers: await ghHeaders() });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(`GitHub API 403: Rate limit exceeded. Provide a GitHub token in App Settings for 5000 req/hr.`);
    }
    throw new Error(`GitHub API ${res.status}: ${res.statusText} for ${url}`);
  }
  return res.json();
}

/** Fetches a GitHub API URL and returns JSON plus the Link header for pagination. */
async function ghFetchWithMeta(url) {
  const res = await fetch(url, { headers: await ghHeaders() });
  if (!res.ok) {
    if (res.status === 403) {
      const msg = `GitHub API 403: Rate limit exceeded. Provide a GitHub token in App Settings for 5000 req/hr.`;
      throw new Error(msg);
    }
    throw new Error(`GitHub API ${res.status}: ${res.statusText} for ${url}`);
  }
  const data = await res.json();
  return { data, link: res.headers.get('link') };
}

// Fetch all repos for an owner (handles pagination)
// Tries /orgs/ first (works for orgs without auth), falls back to /users/ (works for user accounts)
/** Fetches all repos for a GitHub owner (org or user), handling pagination. */
async function fetchReposForOwner(githubUrl) {
  const owner = parseOwner(githubUrl);
  if (!owner) {
    throw new Error(`Could not parse owner from GitHub URL: ${githubUrl}`);
  }

  const repos = [];
  let page = 1;
  const perPage = 100;

  // Try /orgs/ first, fall back to /users/ on 404
  async function fetchPage(endpoint) {
    const url = `${GITHUB_API}${endpoint}?per_page=${perPage}&page=${page}&sort=pushed`;
    const res = await fetch(url, { headers: await ghHeaders() });
    if (!res.ok) {
      if (res.status === 404 && endpoint === `/orgs/${owner}/repos`) {
        return fetchPage(`/users/${owner}/repos`);
      }
      if (res.status === 403) {
        const msg = `GitHub API 403: Rate limit exceeded. Provide a GitHub token in App Settings for 5000 req/hr.`;
        throw new Error(msg);
      }
      throw new Error(`GitHub API ${res.status}: ${res.statusText} for ${url}`);
    }
    return res.json();
  }

  while (true) {
    const data = await fetchPage(`/orgs/${owner}/repos`);
    if (!Array.isArray(data) || data.length === 0) break;

    for (const r of data) {
      repos.push({
        repo_name: r.name,
        full_name: r.full_name,
        repo_url: r.html_url,
        description: r.description,
        default_branch: r.default_branch || 'main',
        stars_count: r.stargazers_count || 0,
        language: r.language,
        pushed_at: r.pushed_at
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}

// Parse last-page number from Link header
/** Extracts the last page number from a GitHub Link header. */
function getLastPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : null;
}

// Fetch the most recent tag for a repo (top result from /tags endpoint, sorted by date)
/** Fetches the most recent tag name for a repo, or null if no tags. */
async function fetchLatestTag(fullName) {
  const data = await ghFetch(`${GITHUB_API}/repos/${fullName}/tags?per_page=1`);
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0].name || null;
}

// Fetch first commit, latest commit, and total count for a repo
/** Fetches first/latest commit info and total commit count for a repo. */
async function fetchCommitHistory(fullName) {
  const result = {
    first_commit_date: null,
    latest_commit_date: null,
    latest_commit_sha: null,
    latest_commit_message: null,
    total_commits: 0
  };

  const perPage = 100;

  // Page 1: get latest commit + Link header for total
  const first = await ghFetchWithMeta(`${GITHUB_API}/repos/${fullName}/commits?per_page=${perPage}&page=1`);
  if (!Array.isArray(first.data) || first.data.length === 0) return result;

  const latest = first.data[0];
  result.latest_commit_sha = latest.sha;
  result.latest_commit_message = latest.commit?.message || null;
  result.latest_commit_date = latest.commit?.author?.date || null;

  // Determine total pages from Link header
  const lastPage = getLastPage(first.link);
  if (lastPage) {
    result.total_commits = (lastPage - 1) * perPage + (first.data.length < perPage ? first.data.length : perPage);
  } else {
    // No Link header: single page, total = length
    result.total_commits = first.data.length;
  }

  // Fetch last page to get first commit
  if (lastPage && lastPage > 1) {
    const last = await ghFetch(`${GITHUB_API}/repos/${fullName}/commits?per_page=${perPage}&page=${lastPage}`);
    if (Array.isArray(last) && last.length > 0) {
      const firstCommit = last[last.length - 1];
      result.first_commit_date = firstCommit.commit?.author?.date || null;
    }
  } else {
    // First commit is on page 1
    const firstCommit = first.data[first.data.length - 1];
    result.first_commit_date = firstCommit.commit?.author?.date || null;
  }

  return result;
}

module.exports = {
  fetchReposForOwner,
  fetchCommitHistory,
  fetchLatestTag
};