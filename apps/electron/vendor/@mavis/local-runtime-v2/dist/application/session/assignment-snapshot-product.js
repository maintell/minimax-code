import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { settleInBackground } from '../../service/plugin-system/index.js';
import { resolveBuiltinPromptAssetsDir } from '../../service/prompt-config/index.js';
import { BUNNY_AGENT_NAME, BunnyTraceStore, markBunnyFirstUse, readPendingBunnyFirstUses, readBunnyWorklines, renderPrecheckPointers, } from '../../service/bunny/index.js';
import { readGlobalConstraintExcerpt, } from '../../service/working-state/index.js';
import { emergencyPayload, createEmergencyArtifacts, emergencyRebuildInEffect, FrozenTurnPrefixes, traceEmergency, } from '../../service/turn-system/index.js';
import { AssignmentSnapshotService, createAssignmentExecutionReminderExtension, createAssignmentStateDelivery, DeliveryBaselineRepository, } from '../../service/assignment/index.js';
/** The execution reminder of Bunny-dispatched task sessions (spec 13.8). */
export function createRuntimeAssignmentExecutionExtension(input) {
    return createAssignmentExecutionReminderExtension({
        sessions: input.sessionSystem.repositories.sessions,
        tasks: input.sessionSystem.repositories.assignmentTasks,
        worklines: {
            list: () => readBunnyWorklines(input.options.bunnyDb),
            sessionSpace: (id) => input.sessionSystem.artifactCatalog.library.sessionSpace(id),
            directory: (id) => input.sessionSystem.artifactCatalog.library.directory(id),
        },
        globalConstraints: () => readGlobalConstraintExcerpt(input.options.bunnyDb, input.nowMs()),
    });
}
/** A Bunny reminder shipped with the application, in the language of the user's message. */
async function readBunnyReminder(name, language) {
    const file = language === 'en' ? `${name}.en.md` : `${name}.md`;
    return readFile(join(await resolveBuiltinPromptAssetsDir(), 'bunny', file), 'utf8');
}
/**
 * Bunny's state ports the Turn System is composed with before Bunny exists:
 * the delta block and frozen prefix, the history observer that moves the
 * delivery baseline, and the Turn's end for Bunny's telemetry. The delivery
 * ports do nothing until bound.
 */
export function bindLateBunnyState(parts = {}) {
    const prefixes = new FrozenTurnPrefixes();
    const traceStore = parts.traceStore ?? new BunnyTraceStore();
    /** Bunny Sessions whose last system prompt could not read memory (emergency rebuild spec 7.1). */
    const memoryUnread = new Set();
    let delivery;
    const port = {
        prefixes,
        prepare: (input) => delivery?.port.prepare(input) ?? Promise.resolve(undefined),
        prefixApplied: (facts) => delivery?.port.prefixApplied?.(facts),
        steeredRecallPointers: (input) => delivery?.port.steeredRecallPointers?.(input) ?? '',
    };
    const observer = {
        observeHistoryCommitted: (input) => delivery?.observer.observeHistoryCommitted(input),
    };
    return {
        prefixes,
        traceStore,
        telemetry: parts.telemetry,
        /** What the memory provider read for a Session's system prompt, and what the delta block asks. */
        memoryReads: {
            read: (sessionId, readable) => {
                if (readable)
                    memoryUnread.delete(sessionId);
                else
                    memoryUnread.add(sessionId);
            },
            unreadable: (sessionId) => memoryUnread.has(sessionId),
        },
        port,
        observer,
        turnEnded: (facts) => parts.telemetry?.turnEnded(facts),
        /**
         * A segment rebuild committed outside the observed history commits: clears
         * the delivery baseline and refreshes the frozen prefix (spec 8.3, 9.4).
         */
        segmentRebuilt: (sessionId) => delivery?.segmentRebuilt(sessionId),
        bind: (value) => {
            delivery = value.delivery;
        },
    };
}
/**
 * Composes Bunny's state delivery (spec 8, 9) once the Bunny owners exist: the
 * delta block renderer, the persisted delivery baseline and the trace.
 */
export function composeBunnyStateDelivery(input) {
    const baseline = new DeliveryBaselineRepository(input.bunnyDb);
    const sessions = input.sessionSystem.repositories.sessions;
    const precheck = input.conversationSearch
        ? (request) => {
            const result = input.conversationSearch.precheck(request);
            return { text: renderPrecheckPointers(result.pointers), trace: result.trace };
        }
        : undefined;
    const snapshots = new AssignmentSnapshotService({
        sessions,
        tasks: input.sessionSystem.repositories.assignmentTasks,
        view: input.stateView,
        baseline,
        worklines: {
            list: () => readBunnyWorklines(input.bunnyDb),
            sessionSpace: (id) => input.sessionSystem.artifactCatalog.library.sessionSpace(id),
            directory: (id) => input.sessionSystem.artifactCatalog.library.directory(id),
            readContext: (id) => input.sessionSystem.artifactCatalog.library.readContext(id),
        },
        previousTurnStartedAt: (sessionId, turnId) => {
            const read = input.inspection?.previousTurnStartedAt;
            if (!read)
                throw new Error('Assignment snapshot turn clock is not bound');
            return read(sessionId, turnId);
        },
        nowMs: input.nowMs,
        viewState: input.viewState,
        bunnyDir: resolveBunnyHomeDir(input.dataDir),
        ...(input.workingState
            ? { ledger: (delivered) => input.workingState.renderDelta(delivered) }
            : {}),
        ...(precheck ? { precheck } : {}),
    });
    const mainConversation = async (sessionId) => {
        const session = await sessions.get(sessionId);
        if (session?.agentName !== BUNNY_AGENT_NAME ||
            session.archived ||
            session.sessionType !== 'root' ||
            session.sessionKind !== 'conversation')
            return undefined;
        const root = await input.sessionSystem.sessions.root.getRootSessionByAgent(BUNNY_AGENT_NAME);
        return root.sessionId === sessionId ? sessionId : undefined;
    };
    const delivery = createAssignmentStateDelivery({
        snapshots,
        baseline,
        isMainConversation: async (sessionId) => (await mainConversation(sessionId)) !== undefined,
        prefixes: input.prefixes,
        nowMs: input.nowMs,
        ...(input.trace ? { trace: input.trace } : {}),
        ...(precheck ? { recallPointers: precheck } : {}),
        onError: (error) => input.failure?.(error),
        // The coordinator runs the emergency rebuild under the same switches (spec 13.2, 13.3).
        skipUnreadable: () => emergencyRebuildInEffect(input.getBunnyContextConfig),
        ...(input.memoryUnreadable ? { memoryUnreadable: input.memoryUnreadable } : {}),
        optionalSkipped: optionalSkipReporter({
            ...(input.emergencyTrace ? { trace: input.emergencyTrace } : {}),
            store: createEmergencyArtifacts(input.sessionSystem.artifacts).store,
            nowMs: input.nowMs,
        }),
        firstMeeting: (language) => readBunnyReminder('first-meeting', language),
        firstUse: {
            pending: async (language) => {
                const pending = readPendingBunnyFirstUses(input.bunnyDb);
                const reminders = await Promise.all(pending.map((item) => readBunnyReminder(`first-use-${item}`, language)));
                return reminders.join('\n');
            },
            reported: () => markBunnyFirstUse(input.bunnyDb, 'report', input.nowMs()),
        },
    });
    /** A write Bunny or the system made itself: the current main conversation already knows. */
    const absorb = (key, state) => {
        settleInBackground((async () => {
            try {
                const root = await input.sessionSystem.sessions.root.getRootSessionByAgent(BUNNY_AGENT_NAME);
                baseline.absorb(root.sessionId, key, state, input.nowMs());
            }
            catch (error) {
                input.failure?.(error);
            }
        })());
    };
    return { delivery, absorb };
}
/** A skip is one handling of an optional part (emergency rebuild spec 2.4, 12.1). */
const OPTIONAL_INJECTION = 'optional_injection';
const NO_REBUILD = 'none';
/**
 * Traces one part a Turn left out as a `bunny.emergency` handling (emergency
 * rebuild spec 12.1) and appends the same payload to the Session's
 * diagnostics record (12.4), as the other handlings do. The Turn goes on
 * without the part, so the skip is recorded as recovered when it happens; a
 * later failure of the Turn is a handling of its own.
 * @internal Exported only for focused tests.
 */
export function optionalSkipReporter(input) {
    return (skip) => {
        const payload = emergencyPayload(skip.sessionId, skip.turnId, {
            action: 'optional_skip',
            category: OPTIONAL_INJECTION,
            level: NO_REBUILD,
            result: 'recovered',
            item: skip.item,
            replacedCounts: { [skip.item]: skip.count },
            affinityRotated: false,
            // Leaving a part out does no work of its own.
            durationMs: 0,
        });
        traceEmergency(input.trace, skip.sessionId, skip.turnId, payload);
        const record = { recorded_at_ms: input.nowMs(), ...payload };
        settleInBackground((async () => {
            try {
                await input.store.appendRecord(skip.sessionId, record);
            }
            catch {
                // The record is best effort, as the coordinator's are (emergency rebuild spec 12.4).
            }
        })());
    };
}
const PLUGIN_SETTINGS_MUTATIONS = [
    'installPlugin',
    'uninstallPlugin',
    'enablePlugin',
    'disablePlugin',
    'updatePlugin',
    'importGithubPlugin',
];
/**
 * The plugin settings facade, refreshing Bunny's frozen tools after each
 * successful change the user makes to the installed or enabled plugins (spec 8.3).
 */
export function withToolSettingsSignal(facade, prefixes) {
    const wrapped = Object.create(facade);
    for (const name of PLUGIN_SETTINGS_MUTATIONS) {
        wrapped[name] = async (req) => {
            const result = await facade[name](req);
            prefixes.toolSettingsChanged();
            return result;
        };
    }
    return wrapped;
}
//# sourceMappingURL=assignment-snapshot-product.js.map