import { readFile, stat } from 'node:fs/promises';
/** Load memory files as sniff candidates; unreadable/missing entries are skipped. */
export async function loadCliSunsetCandidates(input) {
    const candidates = await Promise.all([
        withMtime(input.mainPath, async () => input.mainContent),
        withMtime(input.userPath, async () => input.userContent),
        ...input.topicPaths.map((path) => withMtime(path, () => readFile(path, 'utf8'))),
    ]);
    return candidates.filter((c) => c !== undefined);
}
async function withMtime(path, read) {
    if (!path)
        return undefined;
    try {
        const [content, stats] = await Promise.all([read(), stat(path)]);
        return { path, content, mtimeMs: stats.mtimeMs };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=cli-sunset-notice.js.map