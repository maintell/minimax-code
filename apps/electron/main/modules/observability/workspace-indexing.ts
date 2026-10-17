const STAGES = {
    eligibility: true,
    prepare: true,
    ready: true,
    search: true,
};
const OUTCOMES = {
    eligible: true,
    ineligible: true,
    success: true,
    skipped_limit: true,
    timeout: true,
    failed: true,
    policy_blocked: true,
    disabled: true,
    unavailable: true,
    empty: true,
};
/** The IPC and persisted outbox both admit only bounded, content-free observations. */
export function parseWorkspaceIndexingObservation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const input = value;
    if (typeof input.stage !== 'string' || !Object.prototype.hasOwnProperty.call(STAGES, input.stage))
        return undefined;
    if (typeof input.outcome !== 'string' ||
        !Object.prototype.hasOwnProperty.call(OUTCOMES, input.outcome))
        return undefined;
    if (typeof input.timestampMs !== 'number' ||
        !Number.isSafeInteger(input.timestampMs) ||
        input.timestampMs < 0)
        return undefined;
    if (input.kind !== undefined && input.kind !== 'initial' && input.kind !== 'revision')
        return undefined;
    for (const field of ['durationMs', 'fileCount', 'totalBytes']) {
        const number = input[field];
        if (number !== undefined &&
            (typeof number !== 'number' ||
                !Number.isFinite(number) ||
                number < 0 ||
                number > Number.MAX_SAFE_INTEGER))
            return undefined;
    }
    return {
        stage: input.stage,
        outcome: input.outcome,
        timestampMs: input.timestampMs,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.fileCount !== undefined ? { fileCount: input.fileCount } : {}),
        ...(input.totalBytes !== undefined ? { totalBytes: input.totalBytes } : {}),
    };
}
export function sanitizeWorkspaceIndexingPayload(payload) {
    const observation = parseWorkspaceIndexingObservation(payload);
    const owner = payload.owner_user_id;
    if (!observation || typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
        return {};
    return { ...observation, owner_user_id: owner };
}
