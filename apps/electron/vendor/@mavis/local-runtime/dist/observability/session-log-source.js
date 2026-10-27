import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionLogFile, SESSION_LOG_DIR } from '../common/logger.js';
import { FileDiagnosticArtifactSource } from './diagnostic-bundle.js';
const RECENT_SESSION_COUNT = 5;
const MAX_SESSION_LOG_BYTES = 5 * 1024 * 1024;
/**
 * Per-Session runtime log files, `<logsDir>/sessions/<sessionId>/runtime-MM-DD.log`.
 * A bundle about one Session takes that Session's files; any other bundle
 * takes the five Sessions written to most recently. Files are chosen by
 * Session rather than by the bundle's time window (the directory keeps seven
 * days), and each file is capped to its last 5MB.
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
    });
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
        let names;
        try {
            names = readdirSync(join(dir, sessionId));
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (!isSessionLogFile(name))
                continue;
            try {
                const { mtimeMs } = statSync(join(dir, sessionId, name));
                if (mtimeMs > (lastWrittenMs.get(sessionId) ?? 0))
                    lastWrittenMs.set(sessionId, mtimeMs);
            }
            catch {
                // Removed by the retention sweep meanwhile.
            }
        }
    }
    return [...lastWrittenMs]
        .sort((a, b) => b[1] - a[1])
        .slice(0, RECENT_SESSION_COUNT)
        .map(([sessionId]) => sessionId);
}
//# sourceMappingURL=session-log-source.js.map