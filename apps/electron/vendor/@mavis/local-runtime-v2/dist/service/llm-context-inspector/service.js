import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { LlmContextInspectorServiceError } from './errors.js';
import { compareContextPrefix } from './prefix-comparator.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
const CAPTURE_PREFERENCE_KEY = 'llm-context-inspector.capture';
export class LlmContextInspectorService {
    store;
    db;
    buildVariant;
    nowMs;
    capture = { version: 1, enabled: false, captureEpoch: 0 };
    capturePreferenceLane = new KeyedOperationLane();
    forceCaptureEnabled = false;
    constructor(store, db, buildVariant, nowMs) {
        this.store = store;
        this.db = db;
        this.buildVariant = buildVariant;
        this.nowMs = nowMs;
    }
    async initialize(forceCaptureEnabled = false) {
        this.requireAvailable();
        this.forceCaptureEnabled = forceCaptureEnabled;
        if (this.forceCaptureEnabled)
            return;
        try {
            this.capture = decodeCapturePreference(readPreferenceValue(this.db, CAPTURE_PREFERENCE_KEY));
        }
        catch {
            this.capture = { version: 1, enabled: false, captureEpoch: 0 };
        }
    }
    get available() {
        return this.buildVariant !== 'unavailable';
    }
    getCaptureEnabled() {
        this.requireAvailable();
        return this.forceCaptureEnabled || this.capture.enabled;
    }
    captureState() {
        return {
            enabled: this.available && (this.forceCaptureEnabled || this.capture.enabled),
            epoch: this.capture.captureEpoch,
        };
    }
    async setCaptureEnabled(enabled) {
        this.requireAvailable();
        if (this.forceCaptureEnabled)
            return true;
        return this.capturePreferenceLane.run('capture', async () => {
            if (enabled === this.capture.enabled)
                return this.capture.enabled;
            const next = {
                version: 1,
                enabled,
                captureEpoch: this.capture.captureEpoch + 1,
            };
            upsertPreferenceValue(this.db, CAPTURE_PREFERENCE_KEY, next);
            this.capture = next;
            return enabled;
        });
    }
    listSessions() {
        this.requireAvailable();
        return this.store.listSessions();
    }
    async readOverview(sessionId, knownRevision) {
        this.requireAvailable();
        const revision = await this.store.readRevision(sessionId);
        if (knownRevision !== undefined && knownRevision === revision) {
            return { revision, unchanged: true };
        }
        const snapshot = await this.store.readOverviewSnapshot(sessionId);
        return {
            revision,
            unchanged: false,
            overview: {
                turns: await this.withPrefixComparisons(snapshot.overview.turns, snapshot.readRequestJson),
            },
        };
    }
    async readCall(sessionId, callId) {
        this.requireAvailable();
        const detail = await this.store.readCall(sessionId, callId);
        if (!detail) {
            throw new LlmContextInspectorServiceError(404, 'LLM_CONTEXT_CALL_NOT_FOUND', `call ${callId} was not captured`);
        }
        return {
            callId,
            requestState: detail.request.state,
            ...(detail.request.json === undefined ? {} : { requestJson: detail.request.json }),
            ...(detail.request.byteLength === undefined
                ? {}
                : { requestByteLength: detail.request.byteLength }),
            responseState: detail.response.state,
            ...(detail.response.json === undefined ? {} : { responseJson: detail.response.json }),
            ...(detail.response.byteLength === undefined
                ? {}
                : { responseByteLength: detail.response.byteLength }),
        };
    }
    deleteTurns(sessionId, turnIds) {
        this.requireAvailable();
        return this.store.deleteTurns(sessionId, turnIds);
    }
    clearSessionHistory(sessionId) {
        this.requireAvailable();
        return this.store.clearSession(sessionId);
    }
    async recordCompletedCompaction(sessionId, attemptId) {
        const capture = this.captureState();
        if (!capture.enabled)
            return;
        await this.store.recordCompletedCompaction({
            sessionId,
            attemptId,
            completedAtMs: this.nowMs(),
            captureEpoch: capture.epoch,
        });
    }
    async withPrefixComparisons(turns, readRequestJson) {
        let baseline;
        let baselineRequestJson;
        const projected = [];
        for (const turn of turns) {
            const calls = [];
            for (const call of turn.calls) {
                const currentRequestJson = await readRequestJson(call.callId);
                const prefixComparison = compareContextPrefix({
                    callId: call.callId,
                    providerId: call.providerId,
                    modelId: call.modelId,
                    apiId: call.apiId,
                    captureEpoch: call.captureEpoch,
                    ...(currentRequestJson === undefined ? {} : { requestJson: currentRequestJson }),
                }, baseline
                    ? {
                        callId: baseline.callId,
                        providerId: baseline.providerId,
                        modelId: baseline.modelId,
                        apiId: baseline.apiId,
                        captureEpoch: baseline.captureEpoch,
                        ...(baselineRequestJson === undefined ? {} : { requestJson: baselineRequestJson }),
                    }
                    : undefined);
                calls.push({ ...call, prefixComparison });
                baseline = call;
                baselineRequestJson = currentRequestJson;
            }
            projected.push({ ...turn, calls });
        }
        return projected;
    }
    requireAvailable() {
        if (this.available)
            return;
        throw new LlmContextInspectorServiceError(503, 'LLM_CONTEXT_INSPECTOR_UNAVAILABLE', 'the LLM Context Inspector is not available in this build');
    }
}
function decodeCapturePreference(value) {
    if (value !== null &&
        typeof value === 'object' &&
        Reflect.get(value, 'version') === 1 &&
        typeof Reflect.get(value, 'enabled') === 'boolean' &&
        typeof Reflect.get(value, 'captureEpoch') === 'number' &&
        Number.isSafeInteger(Reflect.get(value, 'captureEpoch')) &&
        Number(Reflect.get(value, 'captureEpoch')) >= 0) {
        return {
            version: 1,
            enabled: Reflect.get(value, 'enabled'),
            captureEpoch: Number(Reflect.get(value, 'captureEpoch')),
        };
    }
    return { version: 1, enabled: false, captureEpoch: 0 };
}
//# sourceMappingURL=service.js.map