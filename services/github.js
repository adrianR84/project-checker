// GitHub API service
// Set GITHUB_TOKEN env var for higher rate limits (5000 req/hr vs 60 req/hr unauthenticated)
const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

function ghHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'project-checker',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

// Parse owner from various GitHub URL formats
function parseOwner(githubUrl) {
  if (!githubUrl) return null;
  const match = githubUrl.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s?#]+)/i);
  return match ? match[1] : null;
}

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    if (res.status === 403) {
      const msg = GITHUB_TOKEN
        ? `GitHub API 403: Rate limit exceeded (token auth). Try again later.`
        : `GitHub API 403: Rate limit exceeded. Set GITHUB_TOKEN env var for 5000 req/hr.`;
      throw new Error(msg);
    }
    throw new Error(`GitHub API ${res.status}: ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function ghFetchWithMeta(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    if (res.status === 403) {
      const msg = GITHUB_TOKEN
        ? `GitHub API 403: Rate limit exceeded (token auth). Try again later.`
        : `GitHub API 403: Rate limit exceeded. Set GITHUB_TOKEN env var for 5000 req/hr.`;
      throw new Error(msg);
    }
    throw new Error(`GitHub API ${res.status}: ${res.statusText} for ${url}`);
  }
  const data = await res.json();
  return { data, link: res.headers.get('link') };
}

// Fetch all repos for an owner (handles pagination)
async function fetchReposForOwner(githubUrl) {
  const owner = parseOwner(githubUrl);
  if (!owner) {
    throw new Error(`Could not parse owner from GitHub URL: ${githubUrl}`);
  }

  const repos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${GITHUB_API}/users/${owner}/repos?per_page=${perPage}&page=${page}&type=public&sort=updated`;
    const data = await ghFetch(url);
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
function getLastPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : null;
}

// Fetch first commit, latest commit, and total count for a repo
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
  parseOwner,
  fetchReposForOwner,
  fetchCommitHistory
};