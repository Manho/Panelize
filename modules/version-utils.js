/**
 * Compare two numeric semantic versions.
 *
 * @param {string} current Current version.
 * @param {string} next Candidate version.
 * @returns {number} -1 when current is older, 0 when equal, and 1 when newer.
 */
export function compareVersions(current, next) {
  const currentParts = current.split('.').map(Number);
  const nextParts = next.split('.').map(Number);
  const maxLength = Math.max(currentParts.length, nextParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const nextPart = nextParts[index] ?? 0;

    if (currentPart < nextPart) {
      return -1;
    }

    if (currentPart > nextPart) {
      return 1;
    }
  }

  return 0;
}
