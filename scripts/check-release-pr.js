#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  getVersionState,
  readText
} from './release-utils.js';
import {
  assertReleaseChangedFiles,
  assertReleaseMetadata,
  getReleaseVersionFromBranch
} from './release-gate.js';

async function main() {
  const repoRoot = process.cwd();
  const headRef = process.env.GITHUB_HEAD_REF || '';
  const baseRef = process.env.GITHUB_BASE_REF || '';

  if (baseRef !== 'main') {
    throw new Error(`Release PR base must be main. Found "${baseRef}"`);
  }

  const version = getReleaseVersionFromBranch(headRef);
  const changedFiles = execFileSync(
    'git',
    ['diff', '--name-only', `origin/${baseRef}...HEAD`],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split(/\r?\n/)
    .map(file => file.trim())
    .filter(Boolean);

  assertReleaseChangedFiles(changedFiles);
  assertReleaseMetadata(
    await getVersionState(repoRoot),
    await readText(repoRoot, 'CHANGELOG.md'),
    version
  );

  console.log(`[release-pr] Validated ${headRef} -> main`);
}

main().catch(error => {
  console.error(`[release-pr] ${error.message}`);
  process.exit(1);
});
