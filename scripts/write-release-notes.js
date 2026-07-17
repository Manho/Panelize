#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidSemver, readText } from './release-utils.js';
import { buildReleaseNotes } from './release-gate.js';

async function main() {
  const repoRoot = process.cwd();
  const version = process.env.RELEASE_VERSION || '';

  if (!isValidSemver(version)) {
    throw new Error(`Invalid release version "${version}". Expected x.y.z`);
  }

  const outputPath = path.join(repoRoot, 'dist', `release-${version}`, 'release-notes.md');
  const changelog = await readText(repoRoot, 'CHANGELOG.md');
  await fs.writeFile(outputPath, buildReleaseNotes(changelog, version));
  console.log(`[release-notes] Created ${outputPath}`);
}

main().catch(error => {
  console.error(`[release-notes] ${error.message}`);
  process.exit(1);
});
