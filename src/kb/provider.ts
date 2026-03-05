// B1 KB Access Layer — GitHub Provider (§3.3)
// First provider. Read-only. No caching. Every fetch is live.
// PAT scoped to fleet-knowledge, contents read-only.

import type {
  AuthorityRecord,
  KbFailure,
  ProviderResolveResult,
  ProviderEnumerateResult,
} from './types';

const GITHUB_API = 'https://api.github.com';

interface GitHubProviderConfig {
  pat: string;
  owner: string;
  repo: string;
}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Edge52-B1-KB',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function failure(errorType: KbFailure['errorType'], message: string, path: string): KbFailure {
  return { errorType, message, path };
}

// §3.3 — Health check: authenticate to GitHub, verify repo access
export async function healthCheck(config: GitHubProviderConfig): Promise<{ healthy: boolean; message: string }> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${config.owner}/${config.repo}`, {
      headers: headers(config.pat),
    });

    if (res.status === 401 || res.status === 403) {
      return { healthy: false, message: `AUTH_FAILURE: GitHub PAT rejected (${res.status})` };
    }
    if (res.status === 404) {
      return { healthy: false, message: `NOT_FOUND: Repository ${config.owner}/${config.repo} not accessible` };
    }
    if (!res.ok) {
      return { healthy: false, message: `PROVIDER_UNAVAILABLE: GitHub returned ${res.status}` };
    }

    return { healthy: true, message: `GitHub provider healthy — ${config.owner}/${config.repo} accessible` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { healthy: false, message: `PROVIDER_UNAVAILABLE: ${msg}` };
  }
}

// Generate content hash (SHA-256 hex digest)
async function contentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// §3.2 — resolve(path) → content + authority record
export async function resolve(config: GitHubProviderConfig, filePath: string): Promise<ProviderResolveResult> {
  try {
    // Call 1: Get file content via Contents API
    const contentsRes = await fetch(
      `${GITHUB_API}/repos/${config.owner}/${config.repo}/contents/${filePath}`,
      { headers: headers(config.pat) }
    );

    if (contentsRes.status === 401 || contentsRes.status === 403) {
      return { success: false, error: failure('AUTH_FAILURE', 'GitHub PAT rejected or insufficient permissions', filePath) };
    }
    if (contentsRes.status === 404) {
      return { success: false, error: failure('NOT_FOUND', `File not found: ${filePath}`, filePath) };
    }
    if (!contentsRes.ok) {
      return { success: false, error: failure('PROVIDER_UNAVAILABLE', `GitHub returned ${contentsRes.status}`, filePath) };
    }

    const contentsData = await contentsRes.json() as {
      content?: string;
      encoding?: string;
      type?: string;
      sha?: string;
    };

    // Reject directories — fetch is for files only
    if (contentsData.type === 'dir') {
      return { success: false, error: failure('INVALID_REQUEST', `Path is a directory, not a file. Use kb_list instead.`, filePath) };
    }

    if (!contentsData.content || contentsData.encoding !== 'base64') {
      return { success: false, error: failure('AUTHORITY_INCONSISTENT', 'GitHub returned content without base64 encoding', filePath) };
    }

    // Decode base64 content
    const content = atob(contentsData.content.replace(/\n/g, ''));

    // Call 2: Get last commit for this file
    const commitsRes = await fetch(
      `${GITHUB_API}/repos/${config.owner}/${config.repo}/commits?path=${encodeURIComponent(filePath)}&per_page=1`,
      { headers: headers(config.pat) }
    );

    if (!commitsRes.ok) {
      return { success: false, error: failure('AUTHORITY_INCONSISTENT', `Could not retrieve commit metadata (${commitsRes.status})`, filePath) };
    }

    const commits = await commitsRes.json() as Array<{
      sha: string;
      commit: { committer: { date: string } };
    }>;

    if (!commits || commits.length === 0) {
      return { success: false, error: failure('AUTHORITY_INCONSISTENT', 'No commit history found for file', filePath) };
    }

    const hash = await contentHash(content);

    const authorityRecord: AuthorityRecord = {
      path: filePath,
      commitSha: commits[0].sha,
      contentHash: hash,
      committedAt: commits[0].commit.committer.date,
    };

    return {
      success: true,
      data: { content, authorityRecord },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: failure('PROVIDER_UNAVAILABLE', `GitHub API error: ${msg}`, filePath) };
  }
}

// §3.2 — enumerate(directory) → file paths
export async function enumerate(config: GitHubProviderConfig, directory: string): Promise<ProviderEnumerateResult> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${config.owner}/${config.repo}/contents/${directory}`,
      { headers: headers(config.pat) }
    );

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: failure('AUTH_FAILURE', 'GitHub PAT rejected or insufficient permissions', directory) };
    }
    if (res.status === 404) {
      return { success: false, error: failure('NOT_FOUND', `Directory not found: ${directory}`, directory) };
    }
    if (!res.ok) {
      return { success: false, error: failure('PROVIDER_UNAVAILABLE', `GitHub returned ${res.status}`, directory) };
    }

    const items = await res.json() as Array<{
      path: string;
      type: string;
      name: string;
    }>;

    if (!Array.isArray(items)) {
      return { success: false, error: failure('AUTHORITY_INCONSISTENT', 'GitHub returned non-array for directory listing', directory) };
    }

    // Return all items with type indicator (file or dir) so callers can navigate
    const paths = items.map(item => item.path);

    return {
      success: true,
      data: { paths },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: failure('PROVIDER_UNAVAILABLE', `GitHub API error: ${msg}`, directory) };
  }
}
