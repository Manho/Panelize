#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  BUMP_COMMIT_FILES,
  getVersionState,
  isValidSemver,
  readText
} from './release-utils.js';
import {
  assertMergedReleasePullRequest,
  assertReleaseChangedFiles,
  assertReleaseCommitIsInMainHistory,
  assertReleaseMetadata,
  assertReleaseTargetsMissing
} from './release-gate.js';

async function githubRequest(repository, path, token, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
  }

  return response.json();
}

function isCommitAncestor(repoRoot, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  return result.status === 0;
}

function assertMetadataMatchesPullRequest(repoRoot, pullNumber, expectedHeadSha) {
  execFileSync('git', ['fetch', '--quiet', 'origin', `pull/${pullNumber}/head`], { cwd: repoRoot });
  const fetchedHeadSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();

  if (fetchedHeadSha !== expectedHeadSha) {
    throw new Error(`Fetched PR head ${fetchedHeadSha} does not match GitHub PR head ${expectedHeadSha}`);
  }

  const comparison = spawnSync(
    'git',
    ['diff', '--quiet', fetchedHeadSha, 'HEAD', '--', ...BUMP_COMMIT_FILES],
    { cwd: repoRoot, stdio: 'ignore' }
  );
  if (comparison.status !== 0) {
    throw new Error('Release metadata on main does not match the merged release PR');
  }
}

async function main() {
  const repoRoot = process.cwd();
  const version = process.env.RELEASE_VERSION || '';
  const pullNumber = Number(process.env.RELEASE_PR_NUMBER);
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';

  if (!isValidSemver(version)) {
    throw new Error(`Invalid release version "${version}". Expected x.y.z`);
  }
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('RELEASE_PR_NUMBER must be a positive integer');
  }
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use owner/repository format');
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const pullRequest = await githubRequest(repository, `/pulls/${pullNumber}`, token);
  const mergeCommitSha = assertMergedReleasePullRequest(pullRequest, version);
  const pullFiles = await githubRequest(repository, `/pulls/${pullNumber}/files?per_page=100`, token);
  const releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();

  if (pullRequest.changed_files > 100) {
    throw new Error('Release PR contains more than 100 changed files');
  }
  assertReleaseChangedFiles(pullFiles.map(file => file.filename));
  assertReleaseCommitIsInMainHistory(
    mergeCommitSha,
    releaseSha,
    isCommitAncestor(repoRoot, mergeCommitSha, releaseSha)
  );
  assertMetadataMatchesPullRequest(repoRoot, pullNumber, pullRequest.head.sha);
  assertReleaseMetadata(
    await getVersionState(repoRoot),
    await readText(repoRoot, 'CHANGELOG.md'),
    version
  );

  const tag = `v${version}`;
  const [tagReference, release] = await Promise.all([
    githubRequest(repository, `/git/ref/tags/${encodeURIComponent(tag)}`, token, { allowNotFound: true }),
    githubRequest(repository, `/releases/tags/${encodeURIComponent(tag)}`, token, { allowNotFound: true })
  ]);
  assertReleaseTargetsMissing({ tagExists: Boolean(tagReference), releaseExists: Boolean(release) }, version);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release_sha=${releaseSha}\n`);
  }

  console.log(`[release-publish] Validated PR #${pullNumber} for v${version} at ${releaseSha}`);
}

main().catch(error => {
  console.error(`[release-publish] ${error.message}`);
  process.exit(1);
});
