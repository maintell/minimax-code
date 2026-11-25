import { CodeHostRequestError } from '../code-host/cli-runner.js';
import { mergeRequestKey, projectKey } from '../code-host/urls.js';
import { MergeRequestError, } from '../contracts.js';
const FAILURE_CODES = {
    cli_missing: 'MERGE_REQUEST_CLI_UNAVAILABLE',
    not_authenticated: 'MERGE_REQUEST_CLI_UNAVAILABLE',
    rate_limited: 'MERGE_REQUEST_RATE_LIMITED',
    timeout: 'MERGE_REQUEST_UPSTREAM_FAILED',
    upstream: 'MERGE_REQUEST_UPSTREAM_FAILED',
    not_found: 'MERGE_REQUEST_NOT_FOUND',
    // A read the account may not make looks the same as one of something that is not there.
    forbidden: 'MERGE_REQUEST_NOT_FOUND',
    head_changed: 'MERGE_REQUEST_HEAD_CHANGED',
    not_mergeable: 'MERGE_REQUEST_NOT_MERGEABLE',
    cannot_retry: 'MERGE_REQUEST_CANNOT_RETRY',
    already_exists: 'MERGE_REQUEST_ALREADY_EXISTS',
    invalid: 'MERGE_REQUEST_REQUEST_INVALID',
};
/** The platform's own words when it gave them, so the panel shows why; the CLI's summary otherwise. */
function messageOf(error) {
    return error.platformMessage ?? error.message;
}
export function toFetchError(error) {
    return { code: FAILURE_CODES[error.kind], message: messageOf(error) };
}
/**
 * Like toServiceError, for a change the user asked for: there a 403 means the
 * account lacks the right on something it can see, so it says so.
 */
export function toActionError(error) {
    if (error instanceof CodeHostRequestError && error.kind === 'forbidden')
        return new MergeRequestError('MERGE_REQUEST_FORBIDDEN', messageOf(error));
    return toServiceError(error);
}
export function toServiceError(error) {
    if (error instanceof MergeRequestError)
        return error;
    if (error instanceof CodeHostRequestError)
        return new MergeRequestError(FAILURE_CODES[error.kind], messageOf(error));
    return new MergeRequestError('MERGE_REQUEST_UPSTREAM_FAILED', error instanceof Error ? error.message : String(error));
}
/** Why this round brought no data for a merge request it asked about. */
export function fetchError(ref, fetched) {
    const outcome = fetched.get(ref.host);
    if (!outcome || outcome.result.mergeRequests.has(mergeRequestKey(ref)))
        return undefined;
    if (outcome.error)
        return toFetchError(outcome.error);
    if (outcome.result.missingProjects.has(projectKey(ref.platform, ref.host, ref.projectPath))) {
        return {
            code: 'MERGE_REQUEST_NOT_FOUND',
            message: 'The project does not exist or this account cannot see it',
        };
    }
    return {
        code: 'MERGE_REQUEST_NOT_FOUND',
        message: 'The merge request does not exist or this account cannot see it',
    };
}
//# sourceMappingURL=fetch-errors.js.map