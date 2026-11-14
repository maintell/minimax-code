import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, max } from 'drizzle-orm';
import { messageRows } from '../../infra/db/schema/messages.js';
import { BUNNY_SETTING_PREFIX } from '../../infra/db/bunny-store.js';
import { bunnyAssignmentTaskEvents, bunnyAssignmentTasks, bunnySettings, } from '../../infra/db/schema/bunny-store.js';
import { schedulerJobs } from '../../infra/db/schema/scheduler.js';
import { SPACE_CONTEXT_FILE, } from '../session-system/index.js';
import { readBunnyInitializedAt } from './initialize.js';
import { listBunnyOwnedSessions } from './reset/reset-data.adapter.js';
import { readBunnyWorklines } from './orchestration/workline.service.js';
import { exportWorkingStateLedger } from '../working-state/index.js';
import { bunnyTraceFile } from './telemetry/trace-store.js';
/** Bunny feedback covers the seven days before the main conversation last replied. */
const BUNNY_FEEDBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Leaves Electron's 120 s request deadline room to receive a partial report. */
const BUNNY_FEEDBACK_COLLECTION_BUDGET_MS = 110_000;
const COLLECTION_TIMEOUT = Symbol('collection-timeout');
/**
 * Read-only collection of a Bunny feedback report. It never writes Bunny data:
 * spaces, memory files and Sessions are read as they are, missing files stay missing.
 */
export function createBunnyFeedbackReport(options) {
    const { db, bunnyDb, dataDir, system } = options;
    const lastMessageAt = (sessionIds, role) => {
        const result = new Map();
        for (let index = 0; index < sessionIds.length; index += 500) {
            const chunk = sessionIds.slice(index, index + 500);
            const scope = inArray(messageRows.sessionId, chunk);
            const rows = db
                .select({ sessionId: messageRows.sessionId, at: max(messageRows.createdAtMs) })
                .from(messageRows)
                .where(role ? and(scope, eq(messageRows.role, role)) : scope)
                .groupBy(messageRows.sessionId)
                .all();
            for (const row of rows)
                if (row.at !== null)
                    result.set(row.sessionId, row.at);
        }
        return result;
    };
    const lastActivity = async (sessionId, messages, completionAt) => {
        let turnAt;
        try {
            turnAt = (await options.latestTurnActivity?.(sessionId))?.activityAtMs;
        }
        catch {
            turnAt = undefined;
        }
        const times = [messages.get(sessionId), turnAt, completionAt].filter((value) => typeof value === 'number');
        return times.length ? Math.max(...times) : undefined;
    };
    const chooseCandidates = async (owners, mainSessionId, startMs, failures) => {
        const { all, assignments, owned } = owners;
        const initializedAt = readBunnyInitializedAt(bunnyDb);
        const byId = new Map(all.map((session) => [session.sessionId, session]));
        const ownedNow = all.filter((session) => session.sessionId === mainSessionId ||
            (owned.has(session.sessionId) &&
                session.purpose !== 'bunny-initialized' &&
                session.createdAtMs >= initializedAt));
        // Descendants travel with the Session above them, so only tops are judged.
        const tops = ownedNow.filter((session) => session.sessionId === mainSessionId ||
            !session.parentSessionId ||
            !owned.has(session.parentSessionId) ||
            !byId.has(session.parentSessionId));
        const messages = subtreeMessageAt(tops.map((session) => session.sessionId), ownedNow, byId, lastMessageAt(ownedNow.map((session) => session.sessionId)));
        const lastRounds = await readLastRoundEvents(system.repositories, failures);
        const candidates = [];
        for (const session of tops) {
            const assignment = assignments.get(session.sessionId);
            const lastActivityAtMs = await lastActivity(session.sessionId, messages, assignment?.completion?.at);
            const reason = candidateReason({
                isMain: session.sessionId === mainSessionId,
                unfinished: Boolean(assignment && !assignment.completion && !session.archived),
                troubled: Boolean(assignment && endedInTrouble(assignment, lastRounds.get(session.sessionId))),
                recent: lastActivityAtMs !== undefined && lastActivityAtMs >= startMs,
            });
            if (!reason)
                continue;
            candidates.push({
                sessionId: session.sessionId,
                reason,
                ...(lastActivityAtMs === undefined ? {} : { lastActivityAtMs }),
            });
        }
        candidates.sort((left, right) => REASON_RANK[left.reason] - REASON_RANK[right.reason] ||
            (right.lastActivityAtMs ?? 0) - (left.lastActivityAtMs ?? 0));
        return candidates;
    };
    const collectGroups = async (candidates, deadline) => {
        const groups = [];
        const pending = [];
        const failures = [];
        const collected = new Set();
        let timedOut = false;
        for (const candidate of candidates) {
            if (collected.has(candidate.sessionId))
                continue;
            const remaining = deadline - options.nowMs();
            const manifest = timedOut || remaining <= 0
                ? COLLECTION_TIMEOUT
                : await collectWithin(system.reporting, candidate.sessionId, remaining, failures);
            if (manifest === COLLECTION_TIMEOUT) {
                timedOut = true;
                pending.push({
                    sessionId: candidate.sessionId,
                    reason: 'timeout',
                    candidateReason: candidate.reason,
                    ...(candidate.lastActivityAtMs === undefined
                        ? {}
                        : { lastActivityAtMs: candidate.lastActivityAtMs }),
                });
            }
            else if (manifest) {
                groups.push(groupFromManifest(candidate, manifest, collected, failures));
            }
        }
        return { groups, pending, failures, timedOut };
    };
    return {
        async collect(input) {
            const startedAt = options.nowMs();
            const deadline = startedAt + (input.budgetMs ?? BUNNY_FEEDBACK_COLLECTION_BUDGET_MS);
            const owners = await listBunnyOwnedSessions(db, system);
            const requested = await system.repositories.sessions.get(input.mainSessionId);
            const replacement = mainReplacement(requested);
            // A stale or replaced ID falls back to Bunny's current main conversation (4.1).
            const mainSessionId = replacement
                ? currentBunnyMain(owners.all)?.sessionId
                : input.mainSessionId;
            const lastReply = mainSessionId === undefined
                ? undefined
                : lastMessageAt([mainSessionId], 'assistant').get(mainSessionId);
            const endMs = lastReply ?? startedAt;
            const startMs = endMs - BUNNY_FEEDBACK_WINDOW_MS;
            const choiceFailures = [];
            const candidates = await chooseCandidates(owners, mainSessionId, startMs, choiceFailures);
            const collected = await collectGroups(candidates, deadline);
            const { groups, pending, timedOut } = collected;
            const failures = [...choiceFailures, ...collected.failures];
            const state = await collectState({
                db,
                bunnyDb,
                dataDir,
                handoffHeader: mainSessionId === undefined
                    ? undefined
                    : await readHandoffHeader(options, mainSessionId, failures),
                // Tasks of Sessions left out still keep their records (4.6).
                sessionIds: [
                    ...groups.flatMap((group) => group.sessionIds),
                    ...pending.map((item) => item.sessionId),
                ],
                routines: owners.routines,
                runs: owners.runs.filter((run) => (run.deliveredAtMs ?? run.createdAtMs) >= startMs),
                failures,
            });
            return {
                schemaVersion: 1,
                kind: 'bunny-feedback',
                requestedMainSessionId: input.mainSessionId,
                ...(mainSessionId === undefined ? {} : { mainSessionId }),
                ...(replacement ? { mainSessionReplacement: replacement } : {}),
                window: {
                    startMs,
                    endMs,
                    endSource: lastReply === undefined ? 'submit-time' : 'last-reply',
                },
                collectedAtMs: options.nowMs(),
                groups,
                pending,
                state: [
                    ...state,
                    // Without a current main conversation, the requested one's trace is the closest.
                    ...traceArtifact(options.trace, mainSessionId ?? input.mainSessionId, failures),
                ],
                failures,
                timedOut,
            };
        },
    };
}
/** Why the requested Session cannot serve as the main conversation, or undefined when it can. */
function mainReplacement(session) {
    if (!session)
        return 'missing';
    if (!isBunnyAgentName(session.agentName))
        return 'not-bunny';
    // A root replaced by a reset is demoted to an archived branch: it is no longer a root.
    if (session.sessionType !== 'root')
        return 'not-root';
    return session.archived ? 'archived' : undefined;
}
/** Bunny's current main conversation: its unarchived conversation root, read without repair. */
function currentBunnyMain(sessions) {
    return sessions
        .filter((session) => isBunnyAgentName(session.agentName) &&
        session.sessionType === 'root' &&
        session.sessionKind === 'conversation' &&
        !session.archived)
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
}
/** The last round outcome (ended or stalled) each task Session recorded. */
async function readLastRoundEvents(repositories, failures) {
    const result = new Map();
    try {
        const events = await repositories.assignmentTasks.listEvents({
            types: ['task.round_ended', 'task.stalled'],
        });
        for (const event of events)
            result.set(event.sessionId, event);
    }
    catch (error) {
        failures.push({ name: 'bunny/candidates#taskEvents', reason: errorReason(error) });
    }
    return result;
}
/** A closed task that ended badly: cancelled, its review gave up, or its last round failed or stalled. */
function endedInTrouble(assignment, lastRound) {
    if (!assignment.completion)
        return false;
    if (assignment.completion.state === 'cancelled' || assignment.reviewError)
        return true;
    if (lastRound?.type === 'task.stalled')
        return true;
    const state = lastRound?.payload.state;
    return state === 'failed' || state === 'aborted' || state === 'interrupted';
}
/**
 * Latest message time of each top Session, counting its descendants: a child
 * still active in the window brings the Session it travels with.
 */
function subtreeMessageAt(topIds, sessions, byId, messages) {
    const tops = new Set(topIds);
    const result = new Map();
    for (const session of sessions) {
        const at = messages.get(session.sessionId);
        if (at === undefined)
            continue;
        let id = session.sessionId;
        for (let depth = 0; id && !tops.has(id) && depth < byId.size; depth += 1) {
            id = byId.get(id)?.parentSessionId ?? undefined;
        }
        if (id && tops.has(id))
            result.set(id, Math.max(result.get(id) ?? at, at));
    }
    return result;
}
const REASON_RANK = {
    'current-main': 0,
    'unfinished-task': 1,
    'troubled-task': 1,
    'recent-activity': 2,
};
function candidateReason(input) {
    if (input.isMain)
        return 'current-main';
    if (input.unfinished)
        return 'unfinished-task';
    // A troubled task is chosen only inside the window, like the rest of the recent work.
    if (!input.recent)
        return undefined;
    return input.troubled ? 'troubled-task' : 'recent-activity';
}
/** A failed Session is recorded and skipped; the rest of the report goes on. */
async function collectWithin(reporting, sessionId, remainingMs, failures) {
    let timer;
    try {
        return await Promise.race([
            reporting.collect(sessionId),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(COLLECTION_TIMEOUT), remainingMs);
            }),
        ]);
    }
    catch (error) {
        failures.push({ name: sessionPrefix(sessionId), reason: errorReason(error) });
        return undefined;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Keeps only artifacts of Sessions not already taken by a higher-priority group. */
function groupFromManifest(candidate, manifest, collected, failures) {
    const sessionIds = manifest.sessionIds.filter((id) => !collected.has(id));
    for (const id of sessionIds)
        collected.add(id);
    const artifacts = [];
    for (const artifact of manifest.artifacts) {
        if (artifact.name === 'session-report-collection.json' && artifact.content) {
            failures.push(...readSkipped(artifact.content));
        }
        else if (sessionIds.some((id) => artifact.name.startsWith(sessionPrefix(id)))) {
            artifacts.push(artifact);
        }
    }
    return { ...candidate, sessionIds, artifacts };
}
async function readHandoffHeader(options, mainSessionId, failures) {
    try {
        return await options.handoffHeader?.(mainSessionId);
    }
    catch (error) {
        failures.push({ name: 'bunny/state.json#handoffHeader', reason: errorReason(error) });
        return undefined;
    }
}
/** Each space's context.md. */
async function spaceMemoryArtifacts(spacesDir, failures) {
    const artifacts = [];
    for (const entry of await listDirectory(spacesDir, failures, 'bunny/spaces')) {
        // `.staging-*` and other `.`-names are never spaces.
        if (!entry.isDirectory() || entry.name.startsWith('.'))
            continue;
        const file = await fileArtifact(join(spacesDir, entry.name, SPACE_CONTEXT_FILE), `bunny/spaces/${entry.name}/${SPACE_CONTEXT_FILE}`, failures);
        if (file)
            artifacts.push(file);
    }
    return artifacts;
}
async function collectState(input) {
    const { db, bunnyDb, dataDir, failures } = input;
    // Assignment tasks and their events live in the Bunny store; the shared database keeps no copy.
    const tasks = input.sessionIds.length
        ? chunked(input.sessionIds, (chunk) => bunnyDb
            .select()
            .from(bunnyAssignmentTasks)
            .where(inArray(bunnyAssignmentTasks.sessionId, chunk))
            .all())
        : [];
    const taskIds = tasks.map((task) => task.taskId);
    const taskEvents = taskIds.length
        ? chunked(taskIds, (chunk) => bunnyDb
            .select()
            .from(bunnyAssignmentTaskEvents)
            .where(inArray(bunnyAssignmentTaskEvents.taskId, chunk))
            .all())
        : [];
    const schedulerIds = input.routines.map((row) => row.schedulerId);
    let spaces = [];
    try {
        spaces = await readBunnyWorklines(bunnyDb);
    }
    catch (error) {
        failures.push({ name: 'bunny/state.json#spaces', reason: errorReason(error) });
    }
    const snapshot = {
        schemaVersion: 1,
        spaces,
        routines: input.routines,
        routineSchedules: schedulerIds.length
            ? chunked(schedulerIds, (chunk) => db.select().from(schedulerJobs).where(inArray(schedulerJobs.schedulerId, chunk)).all())
            : [],
        runs: input.runs,
        settings: bunnyDb
            .select()
            .from(bunnySettings)
            .all()
            .filter((row) => row.key.startsWith(BUNNY_SETTING_PREFIX)),
        tasks,
        taskEvents,
        // The ledger and the current segment's handoff header (13.9).
        workingState: exportWorkingStateLedger(bunnyDb),
        ...(input.handoffHeader === undefined ? {} : { handoffHeader: input.handoffHeader }),
    };
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    const artifacts = [
        {
            name: 'bunny/state.json',
            content,
            bytes: Buffer.byteLength(content, 'utf8'),
            required: true,
        },
    ];
    const home = resolveBunnyHomeDir(dataDir);
    artifacts.push(...(await spaceMemoryArtifacts(join(home, 'spaces'), failures)));
    artifacts.push(...(await treeArtifacts(join(home, 'memory'), 'bunny/memory', failures)));
    const memoryState = await fileArtifact(join(home, '.memory-state.json'), 'bunny/.memory-state.json', failures);
    if (memoryState)
        artifacts.push(memoryState);
    return artifacts;
}
/**
 * The main conversation's trace this run, oldest first: what each Turn was given, how it
 * ended, and each compaction. A restart clears it; the report then has no trace.
 */
function traceArtifact(trace, mainSessionId, failures) {
    if (!trace)
        return [];
    try {
        const content = bunnyTraceFile(trace, mainSessionId);
        return [
            {
                name: 'bunny/trace.json',
                content,
                bytes: Buffer.byteLength(content, 'utf8'),
                required: true,
            },
        ];
    }
    catch (error) {
        failures.push({ name: 'bunny/trace.json', reason: errorReason(error) });
        return [];
    }
}
async function treeArtifacts(dir, prefix, failures) {
    const artifacts = [];
    for (const entry of await listDirectory(dir, failures, prefix)) {
        const path = join(dir, entry.name);
        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory())
            artifacts.push(...(await treeArtifacts(path, name, failures)));
        else if (entry.isFile()) {
            const file = await fileArtifact(path, name, failures);
            if (file)
                artifacts.push(file);
        }
    }
    return artifacts;
}
async function listDirectory(dir, failures, name) {
    try {
        // A linked directory may point outside Bunny's home; it is reported, not followed.
        if ((await lstat(dir)).isSymbolicLink()) {
            failures.push({ name, reason: 'symlink_skipped' });
            return [];
        }
        return (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            failures.push({ name, reason: errorReason(error) });
        }
        return [];
    }
}
/** Missing files are absent, not failures; symlinks are never followed. */
async function fileArtifact(path, name, failures) {
    try {
        const info = await lstat(path);
        if (!info.isFile())
            return undefined;
        return { name, path, bytes: info.size, required: true };
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            failures.push({ name, reason: errorReason(error) });
        }
        return undefined;
    }
}
function chunked(values, read) {
    const result = [];
    for (let index = 0; index < values.length; index += 500) {
        result.push(...read(values.slice(index, index + 500)));
    }
    return result;
}
function sessionPrefix(sessionId) {
    return `session/${encodeURIComponent(sessionId)}`;
}
function readSkipped(content) {
    try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed.skipped)
            ? parsed.skipped.flatMap((item) => item && typeof item === 'object'
                ? [
                    {
                        name: String(Reflect.get(item, 'name')),
                        reason: String(Reflect.get(item, 'reason')),
                    },
                ]
                : [])
            : [];
    }
    catch {
        return [{ name: 'session-report-collection.json', reason: 'unreadable' }];
    }
}
function errorReason(error) {
    const code = typeof error === 'object' && error !== null && Reflect.get(error, 'code');
    if (typeof code === 'string')
        return code;
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=feedback-report.js.map