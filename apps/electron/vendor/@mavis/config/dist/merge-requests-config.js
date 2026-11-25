/** GitLab follows each merge request's own settings, so only GitHub has a preferred method. */
const GITHUB_MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const MERGE_REQUESTS_DEFAULTS = {
    refreshIntervalSec: 60,
    requestBudgetPerHour: 120,
    autoHandleMaxFailures: 3,
    createAsDraft: false,
    githubMergeMethod: 'squash',
};
function isGithubMergeMethod(value) {
    return typeof value === 'string' && GITHUB_MERGE_METHODS.includes(value);
}
export function parseMergeRequestsConfig(raw) {
    const value = raw.mergeRequests;
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    return {
        refreshIntervalSec: positiveInteger(record.refreshIntervalSec, MERGE_REQUESTS_DEFAULTS.refreshIntervalSec),
        requestBudgetPerHour: positiveInteger(record.requestBudgetPerHour, MERGE_REQUESTS_DEFAULTS.requestBudgetPerHour),
        autoHandleMaxFailures: positiveInteger(record.autoHandleMaxFailures, MERGE_REQUESTS_DEFAULTS.autoHandleMaxFailures),
        createAsDraft: typeof record.createAsDraft === 'boolean'
            ? record.createAsDraft
            : MERGE_REQUESTS_DEFAULTS.createAsDraft,
        githubMergeMethod: isGithubMergeMethod(record.githubMergeMethod)
            ? record.githubMergeMethod
            : MERGE_REQUESTS_DEFAULTS.githubMergeMethod,
    };
}
function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
//# sourceMappingURL=merge-requests-config.js.map