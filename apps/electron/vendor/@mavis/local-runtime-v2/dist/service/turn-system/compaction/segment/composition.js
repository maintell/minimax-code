import { SEGMENT_NONE } from '../../../coordinator-text/index.js';
import { SegmentCompactionCoordinator } from './coordinator/coordinator.js';
import { defaultSegmentRecordFacts } from './algorithm/transcript.js';
import { exceedsToolResultWatermark } from './segment-checks.js';
/** Production wiring of the Bunny compaction profile. */
export function createSegmentCompactionCoordinator(input) {
    const ports = {
        history: canonicalSegmentHistory(input.history),
        ...featurePorts(featureResolver(input.features), input.nowMs ?? Date.now),
        ...hostPorts(input),
        trace: createTraceSink(input),
    };
    return new SegmentCompactionCoordinator({
        ports,
        foregroundBudget: input.foregroundBudget,
        ...(input.mainRequestMessages ? { mainRequestMessages: input.mainRequestMessages } : {}),
        exceedsToolResultWatermark,
    });
}
function canonicalSegmentHistory(history) {
    return {
        readSegment: async (sessionId) => {
            const segment = await history.readSegment(sessionId);
            return {
                segmentId: segment.segmentId,
                records: segment.records.map((record) => ({
                    messageId: record.message_id,
                    turnId: record.turn_id,
                    message: record.message,
                })),
            };
        },
    };
}
function featureResolver(source) {
    if (typeof source === 'function')
        return () => source() ?? {};
    const fixed = source ?? {};
    return () => fixed;
}
/**
 * Each port resolves its feature on every call, so a feature bound after the
 * coordinator was built is used from then on; until then the stand-in runs.
 */
function featurePorts(resolve, nowMs) {
    const status = emptyStatus(nowMs);
    return {
        ledger: late(() => resolve().ledger ?? EMPTY_LEDGER),
        deltaBlocks: late(() => resolve().deltaBlocks ?? RECORD_DELTA_BLOCKS),
        status: late(() => resolve().status ?? status),
        spaces: late(() => resolve().spaces ?? NO_SPACES),
        searchIndex: late(() => resolve().searchIndex ?? NO_SEARCH_INDEX),
        recordFacts: late(() => resolve().recordFacts ?? NO_RECORD_FACTS),
    };
}
/** A port whose implementation is looked up at call time. */
function late(resolve) {
    return new Proxy({}, {
        get: (_target, key) => {
            const port = resolve();
            const value = Reflect.get(port, key);
            return typeof value === 'function' ? value.bind(port) : value;
        },
    });
}
function hostPorts(input) {
    return {
        ...(input.mediaDescriptions ? { mediaDescriptions: input.mediaDescriptions } : {}),
        ...(input.getConfig ? { getConfig: input.getConfig } : {}),
        ...recoveryPorts(input),
        ...(input.metrics ? { metrics: input.metrics } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    };
}
/** The emergency rebuild's, the repairs' and the context reset's ports. */
function recoveryPorts(input) {
    return {
        ...(input.emergency ? { emergency: input.emergency } : {}),
        ...(input.emergencyFiles ? { emergencyFiles: input.emergencyFiles } : {}),
        ...(input.classifyFailure ? { classifyFailure: input.classifyFailure } : {}),
        ...(input.historyRepair ? { historyRepair: input.historyRepair } : {}),
        ...(input.configRepair ? { configRepair: input.configRepair } : {}),
        ...(input.contextReset ? { contextReset: input.contextReset } : {}),
    };
}
/**
 * Bunny traces go to the runtime event report and the local structured log,
 * where they land in the Session's own log file (feedback bundles carry it).
 */
function createTraceSink(input) {
    return {
        reportRuntimeEvent: (sessionId, event) => {
            try {
                input.reportRuntimeEvent?.(sessionId, event);
            }
            catch {
                // Diagnostics never change compaction.
            }
            try {
                input.logger?.info?.({
                    event: event.eventType,
                    session_id: sessionId,
                    ...(isRecord(event.payload) ? event.payload : { payload: event.payload }),
                }, event.eventType);
            }
            catch {
                // Diagnostics never change compaction.
            }
            return undefined;
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const EMPTY_LEDGER = {
    readRevision: async () => 'unwired',
    listEntries: async () => [],
    listWrittenNotInHeader: async () => [],
    applyCompactorDelta: async (delta) => ({
        applied: [],
        skipped: delta.operations.map((operation) => ({
            operationId: operation.operationId,
            reason: 'ledger_unavailable',
        })),
        revisionChanged: false,
    }),
    markInHeader: async () => undefined,
    // The empty section, like the status and space stand-ins: the heading the
    // header puts above it already names what would be listed there.
    renderHeader: async () => ({ text: SEGMENT_NONE, entryIds: [], truncated: 0 }),
};
/** The delta block test on the record alone, the same custom type. */
const RECORD_DELTA_BLOCKS = {
    isDeltaBlock: defaultSegmentRecordFacts.isDeltaBlock,
};
function emptyStatus(nowMs) {
    return { readSnapshot: async () => ({ lines: [], cutoffAtMs: nowMs() }) };
}
const NO_SPACES = {
    listSpaces: async () => [],
};
const NO_SEARCH_INDEX = {
    writeMediaDescriptions: async () => undefined,
};
const NO_RECORD_FACTS = {
    resolve: async () => ({}),
};
//# sourceMappingURL=composition.js.map