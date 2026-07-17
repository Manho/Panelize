import {
  assertVersionStateConsistency,
  BUMP_COMMIT_FILES,
  isValidSemver
} from './release-utils.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract and validate the version encoded in a release branch name.
 *
 * @param {string} branchName Release branch name.
 * @returns {string} Release version.
 */
export function getReleaseVersionFromBranch(branchName) {
  const match = /^release\/(\d+\.\d+\.\d+)$/.exec(branchName);
  if (!match) {
    throw new Error(`Release branch must match release/x.y.z. Found "${branchName}"`);
  }

  return match[1];
}

/**
 * Require a release PR to change exactly the configured metadata files.
 *
 * @param {string[]} changedFiles Files changed by the pull request.
 * @param {string[]} allowedFiles Configured release metadata files.
 */
export function assertReleaseChangedFiles(changedFiles, allowedFiles = BUMP_COMMIT_FILES) {
  const actual = Array.from(new Set(changedFiles)).sort();
  const expected = Array.from(new Set(allowedFiles)).sort();
  const unexpected = actual.filter(file => !expected.includes(file));
  const missing = expected.filter(file => !actual.includes(file));

  if (unexpected.length > 0 || missing.length > 0) {
    const details = [];
    if (unexpected.length > 0) {
      details.push(`unexpected: ${unexpected.join(', ')}`);
    }
    if (missing.length > 0) {
      details.push(`missing: ${missing.join(', ')}`);
    }
    throw new Error(`Release PR must change exactly the configured metadata files (${details.join('; ')})`);
  }
}

/**
 * Validate the release version files and changelog entry.
 *
 * @param {Object} versionState Parsed version file values.
 * @param {string} changelog Changelog contents.
 * @param {string} targetVersion Expected release version.
 */
export function assertReleaseMetadata(versionState, changelog, targetVersion) {
  if (!isValidSemver(targetVersion)) {
    throw new Error(`Invalid release version "${targetVersion}". Expected x.y.z`);
  }

  const currentVersion = assertVersionStateConsistency(versionState);
  if (currentVersion !== targetVersion) {
    throw new Error(`Release metadata version ${currentVersion} does not match target ${targetVersion}`);
  }

  const headingPattern = new RegExp(`^## ${escapeRegExp(targetVersion)} - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  if (!headingPattern.test(changelog)) {
    throw new Error(`CHANGELOG.md is missing a dated ${targetVersion} section`);
  }
}

/**
 * Validate the GitHub pull request used for a release.
 *
 * @param {Object} pullRequest GitHub pull request response.
 * @param {string} targetVersion Expected release version.
 * @returns {string} Merge commit SHA.
 */
export function assertMergedReleasePullRequest(pullRequest, targetVersion) {
  const expectedHead = `release/${targetVersion}`;

  if (pullRequest?.head?.ref !== expectedHead) {
    throw new Error(`Release PR head must be ${expectedHead}`);
  }
  if (pullRequest?.base?.ref !== 'main') {
    throw new Error('Release PR base must be main');
  }
  if (!pullRequest.merged_at) {
    throw new Error('Release PR must be merged before publishing');
  }
  if (typeof pullRequest.merge_commit_sha !== 'string' || pullRequest.merge_commit_sha.length === 0) {
    throw new Error('Release PR is missing its merge commit SHA');
  }

  return pullRequest.merge_commit_sha;
}

/**
 * Require the merged release PR to be the current main commit.
 *
 * @param {string} mergeCommitSha Release PR merge commit.
 * @param {string} mainCommitSha Current main commit.
 */
export function assertReleaseCommitIsCurrentMain(mergeCommitSha, mainCommitSha) {
  if (mergeCommitSha !== mainCommitSha) {
    throw new Error(
      `Release PR merge commit ${mergeCommitSha} must be the current main commit ${mainCommitSha}`
    );
  }
}

/**
 * Ensure the release tag and GitHub Release do not exist yet.
 *
 * @param {{tagExists: boolean, releaseExists: boolean}} state Existing target state.
 * @param {string} version Target release version.
 */
export function assertReleaseTargetsMissing(state, version) {
  if (state.tagExists) {
    throw new Error(`Tag v${version} already exists`);
  }
  if (state.releaseExists) {
    throw new Error(`GitHub Release v${version} already exists`);
  }
}

/**
 * Extract the Markdown section for a release version.
 *
 * @param {string} changelog Changelog contents.
 * @param {string} version Release version.
 * @returns {string} Release notes Markdown.
 */
export function extractChangelogSection(changelog, version) {
  const headingPattern = new RegExp(`^## ${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  const match = headingPattern.exec(changelog);
  if (!match) {
    throw new Error(`CHANGELOG.md is missing a dated ${version} section`);
  }

  const sectionStart = match.index;
  const nextHeadingIndex = changelog.indexOf('\n## ', sectionStart + match[0].length);
  return changelog.slice(sectionStart, nextHeadingIndex === -1 ? undefined : nextHeadingIndex).trim() + '\n';
}

/**
 * Build GitHub Release notes, including the store package name.
 *
 * @param {string} changelog Changelog contents.
 * @param {string} version Release version.
 * @returns {string} GitHub Release notes.
 */
export function buildReleaseNotes(changelog, version) {
  return [
    extractChangelogSection(changelog, version).trimEnd(),
    '',
    `Chrome Web Store package: \`panelize-${version}-cws.zip\``,
    ''
  ].join('\n');
}
