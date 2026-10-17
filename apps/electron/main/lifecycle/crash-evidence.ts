import path from "node:path";
import { readSystemSessionEndEvidence } from "../modules/observability/system-session-end";
const CRASH_DUMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CRASH_DUMP_INCIDENT_LOOKBACK_MS = 5000;
/**
 * A native crash of the main process kills every in-process probe, so the
 * crash itself is never reported. Detection therefore works at the session
 * level: a marker file is written at startup and deleted when the quit
 * sequence starts; finding the marker on the next launch means the previous
 * session terminated without ever starting to quit. Crash dumps only refine
 * that signal (has_native_dump) instead of being an event source themselves,
 * which keeps the report bounded to one event per session and avoids
 * double-counting child-process crashes that the live probes already report.
 */
const UNCLEAN_SESSION_CRASH_SOURCE = 'unclean_previous_session';
const MAX_MARKER_APP_VERSION_LENGTH = 32;
const MAX_MARKER_APP_INSTANCE_ID_LENGTH = 64;
function isCrashDumpName(fileName) {
    return path.extname(fileName).toLowerCase() === '.dmp';
}
export class CrashEvidence {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.started = false;
        this.quitStarted = false;
    }
    startCrashEvidence() {
        if (this.started)
            return;
        if (this.dependencies.isAppReady()) {
            throw new Error('Crash evidence must start before Electron app ready');
        }
        const crashDumpsDirectory = this.dependencies.getCrashDumpsDirectory();
        this.dependencies.crashReporter.start({
            uploadToServer: false,
            globalExtra: {
                app_instance_id: this.dependencies.appInstanceId,
                app_version: this.dependencies.appVersion,
            },
        });
        this.started = true;
        this.safeInfo({
            msg: '[CrashEvidence] Local crash reporting started',
            app_instance_id: this.dependencies.appInstanceId,
            crash_dumps_directory: crashDumpsDirectory,
        });
        // Sequential on purpose: the unclean-session check inspects dump files
        // for has_native_dump before retention gets a chance to delete them.
        void (async () => {
            await this.reportPreviousSessionOutcome();
            await this.cleanupOldCrashDumps();
        })().catch((error) => {
            this.safeWarn({
                msg: '[CrashEvidence] Unexpected startup evidence failure',
                error: String(error),
            });
        });
    }
    async cleanupOldCrashDumps() {
        const crashDumpsDirectory = this.dependencies.getCrashDumpsDirectory();
        const cutoffMs = this.dependencies.now() - CRASH_DUMP_RETENTION_MS;
        const dumps = await this.inspectCrashDumps(crashDumpsDirectory);
        const removed = [];
        for (const dump of dumps.sort((left, right) => left.path.localeCompare(right.path))) {
            if (dump.mtimeMs >= cutoffMs)
                continue;
            try {
                await this.dependencies.fileSystem.unlink(dump.path);
                removed.push(dump.path);
            }
            catch (error) {
                this.safeWarn({
                    msg: '[CrashEvidence] Failed to remove expired crash dump',
                    dump_path: dump.path,
                    error: String(error),
                });
            }
        }
        return removed;
    }
    async findLatestCrashDumpSince(timestampMs) {
        if (!Number.isFinite(timestampMs))
            return null;
        const crashDumpsDirectory = this.dependencies.getCrashDumpsDirectory();
        const dumps = await this.inspectCrashDumps(crashDumpsDirectory);
        const candidates = dumps
            .filter((dump) => dump.size > 0 && dump.mtimeMs >= timestampMs)
            .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
        return candidates[0] ?? null;
    }
    findLatestCrashDumpForIncident(occurredAtMs) {
        return this.findLatestCrashDumpSince(occurredAtMs - CRASH_DUMP_INCIDENT_LOOKBACK_MS);
    }
    /**
     * Report the previous session's outcome. Returns 1 when an unclean session
     * was reported, 0 otherwise. Writes the marker for the current session
     * first, before any attribution work.
     */
    async reportPreviousSessionOutcome() {
        const markerPath = this.dependencies.getSessionMarkerFilePath();
        let markerContents;
        try {
            markerContents = this.dependencies.fileSystem.readTextFileSync(markerPath);
        }
        catch {
            // First launch, or the previous session quit cleanly and deleted it.
            markerContents = null;
        }
        // Marker-first, synchronously: everything below awaits (dump scan), and a
        // main-process death before the marker lands would make the next launch
        // read this session as clean. That blind spot hid exactly the worst case -
        // a crash during startup, or a boot crash loop that never survives long
        // enough to finish attribution. The quit path deletes the marker
        // synchronously too, so the latch below is the only ordering needed.
        if (!this.quitStarted) {
            try {
                this.currentSessionMarker = {
                    session_started_at: this.dependencies.now(),
                    app_instance_id: this.dependencies.appInstanceId,
                    app_version: this.dependencies.appVersion,
                    ...this.systemSessionEnd,
                };
                this.dependencies.fileSystem.writeTextFileSync(markerPath, JSON.stringify(this.currentSessionMarker));
            }
            catch (error) {
                // Losing the marker only degrades the next launch's signal to "clean";
                // it must not break startup evidence collection.
                this.safeWarn({
                    msg: '[CrashEvidence] Failed to persist session marker',
                    error: String(error),
                });
            }
        }
        if (markerContents === null)
            return 0;
        const previous = this.parseSessionMarker(markerContents);
        // Attributed to the dead session, not to this one: after a
        // crash-upgrade-restart the current app_version that the outbox stamps on
        // every event belongs to the new build, not to the one that crashed.
        const payload = { source: UNCLEAN_SESSION_CRASH_SOURCE };
        if (previous.sessionStartedAt !== null) {
            // A dump written during the dead session separates real native
            // crashes from external termination (task kill, power loss).
            payload.has_native_dump =
                (await this.findLatestCrashDumpSince(previous.sessionStartedAt)) !== null;
        }
        if (previous.appVersion !== null)
            payload.crashed_app_version = previous.appVersion;
        if (previous.appInstanceId !== null)
            payload.crashed_app_instance_id = previous.appInstanceId;
        Object.assign(payload, previous.systemSessionEnd);
        try {
            this.dependencies.enqueue('app.crash', payload);
            return 1;
        }
        catch (error) {
            this.safeWarn({
                msg: '[CrashEvidence] Failed to report unclean previous session',
                error: String(error),
            });
            return 0;
        }
    }
    /**
     * Delete the session marker as soon as the quit sequence starts. Anything
     * that kills the process after this point is shutdown noise, which matches
     * how quit_in_progress classifies utility incidents.
     */
    recordQuitStarted() {
        this.quitStarted = true;
        try {
            this.dependencies.fileSystem.deleteFileSync(this.dependencies.getSessionMarkerFilePath());
        }
        catch {
            // Absent marker (never started, or already deleted) is not an error.
        }
    }
    /** Observe Windows session-end evidence without changing the quit classification. */
    recordSystemSessionEnd(evidence) {
        try {
            if (this.quitStarted)
                return;
            const bounded = readSystemSessionEndEvidence({ ...evidence });
            if (!bounded)
                return;
            this.systemSessionEnd = bounded;
            // Before startup reads the old marker, retain evidence in memory only.
            if (!this.currentSessionMarker)
                return;
            Object.assign(this.currentSessionMarker, bounded);
            this.dependencies.fileSystem.writeTextFileSync(this.dependencies.getSessionMarkerFilePath(), JSON.stringify(this.currentSessionMarker));
        }
        catch {
            // Diagnostic failures must never cancel session end or interrupt another listener.
            this.safeWarn({ msg: '[CrashEvidence] Failed to persist system session-end evidence' });
        }
    }
    /**
     * Bounded read of the dead session's marker. Every field is independently
     * optional: a marker written by an older build, or one truncated by the
     * crash itself, still yields whatever remains usable. Unparseable content
     * warns once and reports bare.
     */
    parseSessionMarker(contents) {
        let parsed;
        try {
            parsed = JSON.parse(contents);
        }
        catch {
            this.safeWarn({ msg: '[CrashEvidence] Discarding unreadable session marker' });
            return { sessionStartedAt: null, appVersion: null, appInstanceId: null };
        }
        const marker = parsed;
        const startedAt = marker?.session_started_at;
        const appVersion = marker?.app_version;
        const appInstanceId = marker?.app_instance_id;
        const result = {
            systemSessionEnd: marker && typeof marker === 'object' ? readSystemSessionEndEvidence(marker) : undefined,
            sessionStartedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
            appVersion: typeof appVersion === 'string' && appVersion.length <= MAX_MARKER_APP_VERSION_LENGTH
                ? appVersion
                : null,
            appInstanceId: typeof appInstanceId === 'string' &&
                appInstanceId.length <= MAX_MARKER_APP_INSTANCE_ID_LENGTH
                ? appInstanceId
                : null,
        };
        if (result.sessionStartedAt === null) {
            this.safeWarn({ msg: '[CrashEvidence] Discarding unreadable session marker' });
        }
        return result;
    }
    async inspectCrashDumps(rootDirectory) {
        const dumps = [];
        await this.visitDirectory(rootDirectory, dumps);
        return dumps;
    }
    async visitDirectory(directoryPath, dumps) {
        let entries;
        try {
            entries = await this.dependencies.fileSystem.readDirectory(directoryPath);
        }
        catch (error) {
            this.safeWarn({
                msg: '[CrashEvidence] Failed to inspect crash dump directory',
                directory_path: directoryPath,
                error: String(error),
            });
            return;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                continue;
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                await this.visitDirectory(entryPath, dumps);
                continue;
            }
            if (!entry.isFile() || !isCrashDumpName(entry.name))
                continue;
            try {
                const stats = await this.dependencies.fileSystem.lstat(entryPath);
                if (!stats.isFile() || stats.isSymbolicLink())
                    continue;
                dumps.push({
                    name: entry.name,
                    path: entryPath,
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                });
            }
            catch (error) {
                this.safeWarn({
                    msg: '[CrashEvidence] Failed to inspect crash dump file',
                    dump_path: entryPath,
                    error: String(error),
                });
            }
        }
    }
    safeInfo(data) {
        try {
            this.dependencies.logger.info(data);
        }
        catch {
            // Evidence collection must not depend on logging availability.
        }
    }
    safeWarn(data) {
        try {
            this.dependencies.logger.warn(data);
        }
        catch {
            // Evidence collection must remain best-effort when logging fails.
        }
    }
}

