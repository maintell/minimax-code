import { basename, extname } from 'node:path';
const FILE_SEARCH_PATH_TIEBREAKER_WEIGHT = 0.001;
/** Directory candidates retain a trailing slash as their wire-level type marker. */
export function addParentDirectories(candidates) {
    for (const file of [...candidates]) {
        const segments = file.replace(/\\/g, '/').split('/');
        segments.pop();
        while (segments.length > 0) {
            candidates.add(`${segments.join('/')}/`);
            segments.pop();
        }
    }
}
export function scoreFileSearchCandidate(filePath, needle) {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    const normalizedName = basename(normalizedPath);
    const stem = normalizedName.slice(0, normalizedName.length - extname(normalizedName).length);
    const pathIndex = normalizedPath.indexOf(needle);
    if (pathIndex < 0)
        return undefined;
    const nameIndex = normalizedName.indexOf(needle);
    const segments = normalizedPath.split('/').filter(Boolean);
    const matchingSegmentIndex = segments.findIndex((segment) => segment.startsWith(needle));
    const tieBreaker = normalizedPath.length * FILE_SEARCH_PATH_TIEBREAKER_WEIGHT;
    const depthPenalty = Math.max(0, segments.length - 1);
    if (normalizedName === needle)
        return tieBreaker;
    if (stem === needle)
        return 5 + tieBreaker;
    if (normalizedName.startsWith(needle))
        return 10 + normalizedName.length + tieBreaker;
    if (nameIndex >= 0)
        return 20 + nameIndex + normalizedName.length + tieBreaker;
    if (matchingSegmentIndex >= 0)
        return 40 + matchingSegmentIndex + depthPenalty + tieBreaker;
    return 80 + pathIndex + depthPenalty + tieBreaker;
}
//# sourceMappingURL=search-candidates.js.map