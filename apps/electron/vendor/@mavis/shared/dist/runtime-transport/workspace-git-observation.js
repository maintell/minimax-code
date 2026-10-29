/** Optional, bounded diagnostics. Never part of the DesktopService response body. */
export const WORKSPACE_GIT_OBSERVATION_HEADER = 'x-mavis-observation-workspace-git';
export const WORKSPACE_GIT_OBSERVATION_MAX_BYTES = 4096;
export const WORKSPACE_GIT_NUMERIC_FIELDS = [
    'read_ms',
    'changed_files',
    'result_untracked_files',
    'attempts',
    'base_cache_hits',
    'base_inflight_joins',
    'base_loads',
    'full_cache_hits',
    'full_inflight_joins',
    'full_loads',
    'watcher_setup_ms',
    'mutation_wait_ms',
    'classification_wait_ms',
    'base_wait_ms',
    'full_wait_ms',
    'base_compute_ms',
    'full_compute_ms',
    'command_count',
    'command_ms',
    'status_ms',
    'numstat_ms',
    'nonzero_exit_count',
    'untracked_files',
    'untracked_bytes',
    'untracked_ms',
    'max_active_base_loads',
    'max_active_full_loads',
];
const IDENTIFIER = /^[a-zA-Z0-9._:-]{1,160}$/;
const IDS = [
    'workspace_key',
    'start_snapshot',
    'end_snapshot',
    'base_compute_id',
    'full_compute_id',
];
/** Whitelisting also strips accidental paths, raw errors and future unknown fields. */
export function parseWorkspaceGitObservation(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return undefined;
        const input = value;
        if (input.schema !== 1 ||
            (input.mode !== 'fast' && input.mode !== 'full') ||
            (input.outcome !== 'success' && input.outcome !== 'error'))
            return undefined;
        const result = {
            schema: 1,
            mode: input.mode,
            outcome: input.outcome,
        };
        for (const key of WORKSPACE_GIT_NUMERIC_FIELDS) {
            const number = input[key];
            if (typeof number === 'number' &&
                Number.isFinite(number) &&
                number >= 0 &&
                number <= Number.MAX_SAFE_INTEGER)
                result[key] = Math.round(number * 1000) / 1000;
        }
        for (const key of IDS) {
            const id = input[key];
            if (typeof id === 'string' && IDENTIFIER.test(id))
                result[key] = id;
        }
        for (const key of ['is_git_repo', 'result_error']) {
            if (typeof input[key] === 'boolean')
                result[key] = input[key];
        }
        if (input.line_stats === 'ready' ||
            input.line_stats === 'partial' ||
            input.line_stats === 'skipped')
            result.line_stats = input.line_stats;
        if (typeof input.watcher_healthy === 'boolean')
            result.watcher_healthy = input.watcher_healthy;
        if (typeof input.watcher_error === 'string' &&
            ['none', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EMFILE', 'ENFILE', 'unknown'].includes(input.watcher_error))
            result.watcher_error = input.watcher_error;
        if (typeof input.invalidation_reason === 'string' &&
            [
                'none',
                'watcher',
                'watcher-error',
                'mutation',
                'manual',
                'recovery',
                'unhealthy-watcher',
            ].includes(input.invalidation_reason))
            result.invalidation_reason =
                input.invalidation_reason;
        return result;
    }
    catch {
        return undefined;
    }
}
export function encodeWorkspaceGitObservation(value) {
    try {
        const parsed = parseWorkspaceGitObservation(value);
        if (!parsed)
            return undefined;
        const encoded = JSON.stringify(parsed);
        return encoded.length <= WORKSPACE_GIT_OBSERVATION_MAX_BYTES ? encoded : undefined;
    }
    catch {
        return undefined;
    }
}
export function decodeWorkspaceGitObservation(value) {
    try {
        return typeof value === 'string' && value.length <= WORKSPACE_GIT_OBSERVATION_MAX_BYTES
            ? parseWorkspaceGitObservation(JSON.parse(value))
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** A sink may write the optional header synchronously; its async work never gates a read. */
export function emitWorkspaceGitObservation(observer, observation) {
    try {
        void Promise.resolve(observer({ ...observation })).catch(() => { });
    }
    catch {
        // Preserve the business result and original error, even for a broken sink.
    }
}
//# sourceMappingURL=workspace-git-observation.js.map