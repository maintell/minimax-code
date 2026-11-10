import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionLogFile, SESSION_LOG_DIR } from '../logging/logger.js';
import { FileDiagnosticArtifactSource } from './diagnostic-bundle.js';
const RECENT_SESSION_COUNT = 5;
const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024;
/**
 * Per-Session runtime log files, `<logsDir>/sessions/<sessionId>/runtime-MM-DD.log`.
 * A bundle about one Session takes that Session's files; any other bundle
 * takes the five Sessions written to most recently. Files are chosen by
 * Session rather than by the bundle's time window (the directory keeps seven
 * days), and each file is capped to its last 5MB.
 * 反馈装包按会话最后活跃时间设了截止时间时也不截这里：会话自己的日志都要带上。
 */
export function createRuntimeSessionLogSource(logsDir, sessionId) {
    const dir = join(logsDir, SESSION_LOG_DIR);
    const sessionIds = new Set(sessionId ? [sessionId] : recentSessionIds(dir));
    return new FileDiagnosticArtifactSource({
        id: 'runtime-session-logs',
        label: 'Local runtime Session logs',
        dir,
        recursive: true,
        match: (fileName, relativeName) => isSessionLogFile(fileName) && sessionIds.has(relativeName?.split('/')[0] ?? ''),
        prefix: `mavis-runtime/${SESSION_LOG_DIR}/`,
        privacy: 'sensitive',
        uploadDefault: 'consent-required',
        maxBytesPerFile: MAX_SESSION_LOG_BYTES,
        sinceMs: 0,
        untilMs: Number.POSITIVE_INFINITY,
    });
}
/** Latest write time across one Session's log files; undefined when none is readable. */
function lastSessionLogWriteMs(sessionDir) {
    let names;
    try {
        names = readdirSync(sessionDir);
    }
    catch {
        return undefined;
    }
    let latest;
    for (const name of names) {
        if (!isSessionLogFile(name))
            continue;
        try {
            const { mtimeMs } = statSync(join(sessionDir, name));
            if (mtimeMs > (latest ?? 0))
                latest = mtimeMs;
        }
        catch {
            // Removed by the retention sweep meanwhile.
        }
    }
    return latest;
}
function recentSessionIds(dir) {
    let sessionIds;
    try {
        sessionIds = readdirSync(dir);
    }
    catch {
        return [];
    }
    const lastWrittenMs = new Map();
    for (const sessionId of sessionIds) {
        const writtenMs = lastSessionLogWriteMs(join(dir, sessionId));
        if (writtenMs !== undefined)
            lastWrittenMs.set(sessionId, writtenMs);
    }
    return [...lastWrittenMs]
        .sort((a, b) => b[1] - a[1])
        .slice(0, RECENT_SESSION_COUNT)
        .map(([sessionId]) => sessionId);
}
//# sourceMappingURL=session-log-source.js.map