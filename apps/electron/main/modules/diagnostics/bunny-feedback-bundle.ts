const STATE_JSON = 'bunny/state.json';
/** The main conversation's history snapshots are capped; the newest are kept (4.4). */
export let BUNNY_FEEDBACK_MAIN_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
/** `snapshots/g<generation>--…jsonl` and its `env-g<generation>--…json` companion. */
const SNAPSHOT_GENERATION = /^(?:env-)?g(\d+)--/u;
function fits(budget, files, bytes) {
    if (budget.files + files > budget.limits.maxFiles)
        return false;
    if (budget.bytes + bytes > budget.limits.maxBytes)
        return false;
    budget.files += files;
    budget.bytes += bytes;
    return true;
}
const sumBytes = (artifacts) => artifacts.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0);
/**
 * Fits Bunny's report into the bundle, in this order: `bunny/state.json`, the
 * current main conversation (its history snapshots capped, newest kept), the
 * other state files, then the remaining Session groups by the report's priority.
 * A group goes in whole with its runtime logs (`sessionLogCost`), or is listed as
 * skipped with its tier and last activity; its task records stay in the state
 * file. The main conversation's own runtime logs, which hold its compaction
 * traces, still go in when its group does not fit or its report failed.
 */
export function packBunnyFeedbackReport(input) {
    let decoded;
    let error = input.error;
    if (!error) {
        try {
            decoded = decodeBunnyFeedbackReport(input.report);
        }
        catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
        }
    }
    // Without a report, the requested ID is the only main conversation known.
    const mainSessionId = decoded ? decoded.mainSessionId : input.mainSessionId;
    const budget = { files: 0, bytes: 0, limits: input.limits };
    const state = [];
    const skippedState = [];
    const included = [];
    const skippedSessions = [...(decoded?.pending ?? [])];
    const addState = (artifact) => {
        if (fits(budget, 1, artifact.bytes ?? 0))
            state.push(artifact);
        else
            skippedState.push({ name: artifact.name, reason: 'bundle_limit' });
    };
    const fitsLogs = (sessionIds) => {
        const logs = input.sessionLogCost?.(sessionIds) ?? { files: 0, bytes: 0 };
        return fits(budget, logs.files, logs.bytes);
    };
    const addGroup = (group) => {
        const logs = input.sessionLogCost?.(group.sessionIds) ?? { files: 0, bytes: 0 };
        const files = group.artifacts.length + logs.files;
        if (fits(budget, files, sumBytes(group.artifacts) + logs.bytes))
            included.push(group);
        else
            skippedSessions.push({
                sessionId: group.sessionId,
                reason: 'bundle_limit',
                candidateReason: group.reason,
                ...(group.lastActivityAtMs === undefined
                    ? {}
                    : { lastActivityAtMs: group.lastActivityAtMs }),
            });
    };
    const stateJson = decoded?.state.find((artifact) => artifact.name === STATE_JSON);
    if (stateJson)
        addState(stateJson);
    let droppedMainSnapshots = 0;
    const groups = (decoded?.groups ?? []).map((group) => {
        if (group.reason !== 'current-main' || !mainSessionId)
            return group;
        const capped = capMainSnapshots(group.artifacts, mainSessionId, input.mainSnapshotMaxBytes ?? BUNNY_FEEDBACK_MAIN_SNAPSHOT_MAX_BYTES);
        droppedMainSnapshots += capped.dropped;
        return { ...group, artifacts: capped.artifacts };
    });
    for (const group of groups)
        if (group.reason === 'current-main')
            addGroup(group);
    const mainLogsAlone = mainSessionId !== undefined &&
        decoded !== undefined &&
        !included.some((group) => group.sessionIds.includes(mainSessionId)) &&
        fitsLogs([mainSessionId]);
    for (const artifact of decoded?.state ?? [])
        if (artifact !== stateJson)
            addState(artifact);
    for (const group of groups)
        if (group.reason !== 'current-main')
            addGroup(group);
    const includedIds = included.flatMap((group) => group.sessionIds);
    const logIds = decoded ? [...new Set(includedIds)] : [input.mainSessionId];
    if (mainLogsAlone && mainSessionId && !logIds.includes(mainSessionId)) {
        logIds.unshift(mainSessionId);
    }
    const collection = {
        schemaVersion: 1,
        requestedMainSessionId: decoded?.requestedMainSessionId ?? input.mainSessionId,
        ...(mainSessionId === undefined ? {} : { mainSessionId }),
        ...(decoded?.mainSessionReplacement
            ? { mainSessionReplacement: decoded.mainSessionReplacement }
            : {}),
        ...(decoded
            ? {
                window: decoded.window,
                collectedAtMs: decoded.collectedAtMs,
                timedOut: decoded.timedOut,
            }
            : {}),
        sessions: included.map(({ artifacts: _artifacts, ...group }) => group),
        skippedSessions,
        droppedMainSnapshots,
        // What Bunny's part of the bundle may take and took, runtime logs included.
        budget: { maxBytes: input.limits.maxBytes, maxFiles: input.limits.maxFiles },
        used: { bytes: budget.bytes, files: budget.files },
        ...(skippedState.length > 0 ? { skippedState } : {}),
        failures: decoded?.failures ?? [],
        ...(error ? { error } : {}),
    };
    const artifacts = [
        ...state,
        ...included.flatMap((group) => group.artifacts),
        { name: 'bunny/collection.json', content: JSON.stringify(collection, null, 2) },
    ];
    // An empty selection would make the log source fall back to the latest Sessions;
    // the main conversation's logs (at most a week of capped files) fit the reserve.
    return { artifacts, sessionIds: logIds.length > 0 ? logIds : [input.mainSessionId] };
}
/**
 * Keeps the main conversation's newest history snapshots within `maxBytes`. A snapshot is
 * one generation: its history file and its request companion. Once a generation does not
 * fit, it and every older one are dropped, so what stays is the most recent run of them.
 */
function capMainSnapshots(artifacts, mainSessionId, maxBytes) {
    const prefix = `session/${encodeURIComponent(mainSessionId)}/snapshots/`;
    const generations = new Map();
    for (const artifact of artifacts) {
        if (!artifact.name.startsWith(prefix))
            continue;
        const match = SNAPSHOT_GENERATION.exec(artifact.name.slice(prefix.length));
        // A file whose generation is unknown counts as the oldest.
        const generation = match ? Number(match[1]) : -1;
        generations.set(generation, [...(generations.get(generation) ?? []), artifact]);
    }
    const dropped = new Set();
    let bytes = 0;
    let full = false;
    let droppedCount = 0;
    for (const generation of [...generations.keys()].sort((left, right) => right - left)) {
        const files = generations.get(generation) ?? [];
        if (!full && bytes + sumBytes(files) <= maxBytes) {
            bytes += sumBytes(files);
            continue;
        }
        full = true;
        droppedCount += generation < 0 ? files.length : 1;
        for (const file of files)
            dropped.add(file);
    }
    return {
        artifacts: artifacts.filter((artifact) => !dropped.has(artifact)),
        dropped: droppedCount,
    };
}
function decodeBunnyFeedbackReport(value) {
    if (!value || typeof value !== 'object' || Reflect.get(value, 'kind') !== 'bunny-feedback') {
        throw new Error('bunny_feedback_invalid_report');
    }
    const list = (key) => {
        const items = Reflect.get(value, key);
        if (!Array.isArray(items))
            throw new Error('bunny_feedback_invalid_report');
        return items;
    };
    const text = (item, key) => {
        const field = item && typeof item === 'object' ? Reflect.get(item, key) : undefined;
        if (typeof field !== 'string' || !field)
            throw new Error('bunny_feedback_invalid_report');
        return field;
    };
    const groups = list('groups').map((group) => {
        const sessionIds = Reflect.get(group, 'sessionIds');
        const artifacts = Reflect.get(group, 'artifacts');
        const lastActivityAtMs = Reflect.get(group, 'lastActivityAtMs');
        if (!Array.isArray(sessionIds) || !Array.isArray(artifacts)) {
            throw new Error('bunny_feedback_invalid_report');
        }
        return {
            sessionId: text(group, 'sessionId'),
            reason: text(group, 'reason'),
            ...(typeof lastActivityAtMs === 'number' ? { lastActivityAtMs } : {}),
            sessionIds: sessionIds.filter((id) => typeof id === 'string'),
            artifacts: artifacts.map((artifact) => decodeRequiredUploadArtifact(artifact)),
        };
    });
    const optionalText = (item, key) => {
        const field = item && typeof item === 'object' ? Reflect.get(item, key) : undefined;
        return typeof field === 'string' && field ? field : undefined;
    };
    const requestedMainSessionId = optionalText(value, 'requestedMainSessionId');
    const mainSessionId = optionalText(value, 'mainSessionId');
    const mainSessionReplacement = optionalText(value, 'mainSessionReplacement');
    return {
        ...(requestedMainSessionId ? { requestedMainSessionId } : {}),
        mainSessionId,
        ...(mainSessionReplacement ? { mainSessionReplacement } : {}),
        window: Reflect.get(value, 'window'),
        collectedAtMs: Reflect.get(value, 'collectedAtMs'),
        timedOut: Reflect.get(value, 'timedOut') === true,
        groups,
        pending: list('pending').map((item) => {
            const candidateReason = optionalText(item, 'candidateReason');
            const lastActivityAtMs = Reflect.get(item, 'lastActivityAtMs');
            return {
                sessionId: text(item, 'sessionId'),
                reason: text(item, 'reason'),
                ...(candidateReason ? { candidateReason } : {}),
                ...(typeof lastActivityAtMs === 'number' ? { lastActivityAtMs } : {}),
            };
        }),
        state: list('state').map((artifact) => decodeRequiredUploadArtifact(artifact)),
        failures: list('failures').map((item) => ({
            name: String(item && typeof item === 'object' ? Reflect.get(item, 'name') : item),
            reason: String(item && typeof item === 'object' ? Reflect.get(item, 'reason') : ''),
        })),
    };
}
/** Session report artifacts cross the utility boundary as plain records; trust none of them. */
export function decodeRequiredUploadArtifact(value) {
    if (!value || typeof value !== 'object')
        throw new Error('session_report_invalid_artifact');
    const name = Reflect.get(value, 'name');
    const path = Reflect.get(value, 'path');
    const content = Reflect.get(value, 'content');
    const bytes = Reflect.get(value, 'bytes');
    const required = Reflect.get(value, 'required');
    if (typeof name !== 'string' ||
        !name ||
        required !== true ||
        (path !== undefined && typeof path !== 'string') ||
        (content !== undefined && typeof content !== 'string') ||
        (path === undefined) === (content === undefined) ||
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0) {
        throw new Error('session_report_invalid_artifact');
    }
    return {
        name,
        ...(path === undefined ? {} : { path }),
        ...(content === undefined ? {} : { content }),
        bytes,
    };
}
