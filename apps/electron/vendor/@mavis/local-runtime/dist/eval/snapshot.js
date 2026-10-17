import { boundedJsonStringify } from '@mavis/shared/bounded-json-stringify';
import { isSensitiveFieldKey, LOCAL_PI_CAPTURE_ORIGIN, maskText } from './payload.js';
export function buildLocalEvalSnapshotRequest(options) {
    const { trajectoryId, sessionId, input, targetModel, clientProducedTs, seq, sensitiveValues, maxBytes, } = options;
    const snapshotResult = boundedJsonStringify({
        schema: 'mavis.cloud_eval_snapshot.v1',
        capture_origin: 'LocalPi',
        trajectory_id: trajectoryId,
        session_id: sessionId,
        turn_id: input.turnId,
        phase: input.phase,
        target_model: targetModel,
        thinking_level: input.thinkingLevel ?? null,
        system_prompt: input.systemPrompt ?? '',
        ...(input.promptMetadata ? { prompt_metadata: input.promptMetadata } : {}),
        messages: input.messages,
        tools: input.tools ?? [],
        client_produced_ts: clientProducedTs,
    }, {
        maxBytes,
        isSensitiveFieldKey,
        maskString: (value) => maskText(value, sensitiveValues),
    });
    if (snapshotResult.status === 'limit_exceeded') {
        return { status: 'oversized', atLeastBytes: snapshotResult.atLeastBytes };
    }
    const snapshotJson = snapshotResult.status === 'success'
        ? snapshotResult.json
        : JSON.stringify({ serialization_error: true });
    if (Buffer.byteLength(snapshotJson, 'utf8') > maxBytes) {
        return { status: 'oversized', atLeastBytes: maxBytes + 1 };
    }
    const bodyResult = boundedJsonStringify({
        trajectory_id: trajectoryId,
        capture_origin: LOCAL_PI_CAPTURE_ORIGIN,
        seq,
        snapshot_json: snapshotJson,
        target_model: targetModel,
        messages_count: input.messages.length,
        turn_id: input.turnId,
        client_produced_ts: clientProducedTs,
    }, { maxBytes });
    if (bodyResult.status === 'limit_exceeded') {
        return { status: 'oversized', atLeastBytes: bodyResult.atLeastBytes };
    }
    if (bodyResult.status === 'error') {
        return { status: 'serialization_error', error: bodyResult.error };
    }
    return {
        status: 'ready',
        sizeBytes: bodyResult.sizeBytes,
        request: {
            kind: 'snapshot',
            body: bodyResult.json,
        },
    };
}
//# sourceMappingURL=snapshot.js.map