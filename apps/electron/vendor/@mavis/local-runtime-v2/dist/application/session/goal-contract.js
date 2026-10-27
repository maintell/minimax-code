/**
 * Shared, transport-agnostic thread-goal contract glue.
 *
 * Bridges the IDL-generated DesktopService goal contract (flat structs from
 * `matrix/api_common/goal.thrift`, addressed by session_id) onto the internal
 * `@mavis/goal` `ThreadGoalStore` model. Kept free of any HTTP `Response` /
 * Hono coupling so both the generated DesktopService methods and unit tests
 * can reuse the exact same mapping + validation logic without duplication.
 *
 * Impedance handled here:
 *  - i64 timestamps / token counters surface as `number` (Unix ms / raw) —
 *    identity here.
 *  - `token_budget` tri-state on PATCH: field omitted (`undefined`) = leave
 *    as-is; `0` = clear the cap (→ `null`); positive integer = set the cap.
 *    This mirrors the store's `positiveOrNull` (any non-positive value =
 *    "no cap"), the same trick as cron `keep_sessions=0 = keep-all` — so no
 *    dedicated `clear_token_budget` flag is needed.
 *  - Status transitions are validated here only against the enum. The one
 *    real guard — no re-entry into `active` from `complete` or
 *    `budget_limited` — lives in the store and surfaces as 409
 *    `GOAL_STATUS_CONFLICT` / `GOAL_BUDGET_LIMITED`. Objective length is
 *    unrestricted.
 */
import { validateThreadGoalObjective, } from '@mavis/goal';
import { GOAL_VERIFIER_SESSION_FORBIDDEN, globalUsageRecovery } from '../../service/goal/index.js';
const VALID_STATUSES = new Set([
    'active',
    'paused',
    'complete',
    'blocked',
    'budget_limited',
    'usage_limited',
]);
const DEFAULT_GOAL_CONTRACT_POLICY = {};
const UNREADABLE_ATTACHMENT_MESSAGES = new Set([
    'invalid_asset_data_url',
    'asset_source_required',
    'asset_source_not_file',
    'asset_remote_url_invalid',
    'asset_remote_unreadable',
    'Local attachment source is unreadable or invalid',
]);
const UNREADABLE_ATTACHMENT_CODES = new Set([
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOTDIR',
    'EISDIR',
]);
/** Transport-agnostic error carrying the HTTP status + machine code to map. */
export class ThreadGoalContractError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'ThreadGoalContractError';
    }
}
/** Map the internal canonical goal record onto the generated flat GoalState. */
export function goalStateToGoalState(state) {
    return {
        goalId: state.goalId,
        sessionId: state.sessionId,
        objective: state.objective,
        objectiveResources: (state.objectiveResources ?? []).map((resource) => ({
            meta: {
                attachmentType: resource.type,
                fileName: resource.fileName,
                mimeType: resource.mimeType,
            },
            local: { assetId: resource.assetId, filePath: resource.filePath },
        })),
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        ...(state.dismissedAt !== undefined ? { dismissedAt: state.dismissedAt } : {}),
        tokensUsed: state.tokensUsed,
        turnsUsed: state.turnsUsed,
        timeUsedSeconds: state.timeUsedSeconds,
        hasKickoffAttachments: state.kickoffAttachments.length > 0,
        ...(state.statusReason !== null ? { statusReason: state.statusReason } : {}),
        ...(state.lastVerification !== undefined
            ? {
                lastVerification: {
                    backend: state.lastVerification.backend,
                    verdict: state.lastVerification.verdict,
                    reason: state.lastVerification.reason,
                    missing: [...state.lastVerification.missing],
                    notMetStreak: state.lastVerification.notMetStreak,
                    at: state.lastVerification.at,
                },
            }
            : {}),
        // `null` cap surfaces as omitted (0 / absent = uncapped on the wire).
        ...(state.tokenBudget !== null ? { tokenBudget: state.tokenBudget } : {}),
        // Omitted entirely when nothing blocks the Goal, so an unblocked Goal looks
        // identical to one from a runtime that predates this field.
        ...(state.executionWait !== null
            ? {
                execution: {
                    waitReason: state.executionWait.reason,
                    waitSince: state.executionWait.sinceMs,
                },
            }
            : {}),
        ...requestAccountingToWire(state.accounting),
        ...tokenUsageToWire(state.tokenUsage),
        // Spec §7: only whether the Goal resumes by itself, never the reset time.
        ...globalUsageRecovery(state),
    };
}
/**
 * The four token parts of a full-usage Goal; absent for a legacy Goal, so an
 * old client keeps reading `tokens_used` alone. A cache write that was never
 * reported is left out rather than sent as 0.
 */
function tokenUsageToWire(usage) {
    if (!usage)
        return {};
    return {
        tokenUsage: {
            inputTokens: usage.input,
            ...(usage.cacheWriteUnreported ? {} : { cacheWriteTokens: usage.cacheWrite }),
            cacheReadTokens: usage.cacheRead,
            outputTokens: usage.output,
        },
    };
}
/**
 * The request ledger projection (accounting version 2). Absent for a Goal not
 * counted in requests, so a client never relabels `turns_used` as requests.
 */
function requestAccountingToWire(accounting) {
    if (!accounting)
        return {};
    return {
        accountingVersion: accounting.version,
        requestsUsed: accounting.requestsUsed,
        workRequests: accounting.workRequests,
        graceRequests: accounting.graceRequests,
        legacyTurns: accounting.legacyTurns,
        reservedRequests: accounting.reservedRequests,
        unknownRequests: accounting.unknownRequests,
        usageIncomplete: accounting.usageIncomplete,
    };
}
/**
 * Build an internal `ThreadGoalCreateInput` from the generated CreateGoalReq.
 * `objective` is required + validated; `token_budget` is `0`/omitted = no cap,
 * positive = cap. The store treats `undefined` and `null` identically on
 * create, so we only pass a positive budget through.
 */
export function createGoalReqToCreateInput(req, policy = DEFAULT_GOAL_CONTRACT_POLICY) {
    const sessionId = requireNonEmpty(req.sessionId, 'session_id');
    const objective = (req.objective ?? '').trim();
    assertObjective(objective, policy.objectiveMaxChars);
    const tokenBudget = budgetFromWire(req.tokenBudget);
    const kickoffAttachments = (req.attachments ?? []).flatMap((attachment) => {
        const mapped = toKickoffAttachment(attachment);
        return mapped ? [mapped] : [];
    });
    return {
        sessionId,
        objective,
        ...(req.objectiveResources !== undefined
            ? { objectiveResources: mapObjectiveResources(req.objectiveResources) }
            : {}),
        ...(tokenBudget !== null ? { tokenBudget } : {}),
        ...(kickoffAttachments.length > 0 ? { kickoffAttachments } : {}),
    };
}
/**
 * Build an internal `ThreadGoalPatchInput` from the generated PatchGoalReq.
 * Tri-state token_budget:
 *   - field omitted (`undefined`) → key absent → store leaves it alone.
 *   - `0` → `null` → store clears the cap.
 *   - positive integer → set the cap.
 * `status` is enum-validated; `objective` (when present) is non-empty +
 * length validated. The transition guard itself belongs to the store.
 *
 * This translator deliberately does not derive `statusReason`. `PatchGoalReq`
 * has no such field, so anything written here is invented domain state — and
 * an invented reason previously made every wire pause fail the lifecycle's
 * user-pause check, silently downgrading it to a plain field patch. Reason
 * derivation now lives in `GoalLifecycle`.
 *
 * Returns the patch shape plus:
 *   - `hasChange`, used to reject an empty PATCH with 400 (mirrors the legacy
 *     route's "must include status, objective, or tokenBudget" guard);
 *   - `isUserPause`, the explicit intent the route uses to select
 *     `pauseGoalByUser` over the generic field patch.
 */
export function patchGoalReqToPatchInput(req, policy = DEFAULT_GOAL_CONTRACT_POLICY) {
    // Spread order is validation order: each part throws its own 400/415.
    const patch = {
        ...concurrencyPatch(req),
        ...objectiveResourcesPatch(req),
        ...statusPatch(req),
        ...objectivePatch(req, policy),
        ...tokenBudgetPatch(req),
    };
    const hasChange = req.status !== undefined || req.objective !== undefined || req.tokenBudget !== undefined;
    // A bare `status: paused` is the user leaving the Goal. Anything paired with
    // an objective or budget edit is a field patch that merely happens to also
    // pause, and must keep the generic path's compare-and-set semantics.
    const isUserPause = req.status === 'paused' &&
        req.objective === undefined &&
        req.tokenBudget === undefined &&
        req.expectedGoalId === undefined;
    return { patch, hasChange, isUserPause };
}
function concurrencyPatch(req) {
    if ((req.expectedGoalId === undefined) !== (req.expectedUpdatedAt === undefined)) {
        throw new ThreadGoalContractError(400, 'Goal concurrency fields must be supplied together.', 'VALIDATION_ERROR');
    }
    if (req.expectedGoalId === undefined)
        return {};
    requireNonEmpty(req.expectedGoalId, 'expected_goal_id');
    if (!Number.isSafeInteger(req.expectedUpdatedAt) || (req.expectedUpdatedAt ?? -1) < 0) {
        throw new ThreadGoalContractError(400, 'Invalid expected_updated_at.', 'VALIDATION_ERROR');
    }
    return {
        expectedGoalId: req.expectedGoalId,
        rejectIfUpdatedAtChangedFrom: req.expectedUpdatedAt,
    };
}
function objectiveResourcesPatch(req) {
    if (req.objectiveResources === undefined)
        return {};
    if (req.objective === undefined) {
        throw new ThreadGoalContractError(400, 'objective_resources requires objective.', 'VALIDATION_ERROR');
    }
    return { objectiveResources: mapObjectiveResources(req.objectiveResources) };
}
function statusPatch(req) {
    if (req.status === undefined)
        return {};
    assertGoalStatus(req.status);
    return { status: req.status };
}
function objectivePatch(req, policy) {
    if (req.objective === undefined)
        return {};
    const objective = req.objective.trim();
    assertObjective(objective, policy.objectiveMaxChars);
    return { objective };
}
/**
 * 0 → clear (null); positive → set. (Negative is coerced to clear too,
 * matching the store's `positiveOrNull` defence-in-depth.)
 */
function tokenBudgetPatch(req) {
    if (req.tokenBudget === undefined)
        return {};
    return { tokenBudget: req.tokenBudget > 0 ? Math.floor(req.tokenBudget) : null };
}
/** Validate a goal status string, throwing a contract error on failure. */
function assertGoalStatus(status) {
    if (!VALID_STATUSES.has(status)) {
        throw new ThreadGoalContractError(400, `Invalid status: "${status}"`, 'VALIDATION_ERROR');
    }
}
/**
 * Map an arbitrary store error onto a ThreadGoalContractError. The
 * already-exists sentinel (`ThreadGoalAlreadyExistsError`) carries
 * `name === 'ThreadGoalAlreadyExistsError'`, mapped to 409; "not found" →
 * 404; otherwise honor an explicit statusCode or fall back to 500.
 */
export function toThreadGoalContractError(err) {
    if (err instanceof ThreadGoalContractError)
        return err;
    const candidate = err;
    const message = typeof candidate.message === 'string' ? candidate.message : String(err);
    const code = typeof candidate.code === 'string' ? candidate.code : undefined;
    const attachmentError = toGoalAttachmentContractError(candidate, message, code);
    if (attachmentError)
        return attachmentError;
    const namedCode = typeof candidate.name === 'string' ? NAMED_GOAL_ERROR_CODES.get(candidate.name) : undefined;
    if (namedCode)
        return new ThreadGoalContractError(409, message, namedCode);
    return new ThreadGoalContractError(fallbackErrorStatus(candidate.statusCode, message), message, code);
}
/** Store and lifecycle errors identified by name; every one of them is a 409. */
const NAMED_GOAL_ERROR_CODES = new Map([
    ['ThreadGoalAlreadyExistsError', 'GOAL_EXISTS'],
    ['ThreadGoalBudgetLimitedError', 'GOAL_BUDGET_LIMITED'],
    ['ThreadGoalTokenBudgetExhaustedError', 'GOAL_TOKEN_BUDGET_EXHAUSTED'],
    ['ThreadGoalVerifierSessionError', GOAL_VERIFIER_SESSION_FORBIDDEN],
    ['ThreadGoalStatusConflictError', 'GOAL_STATUS_CONFLICT'],
    ['ThreadGoalEpochConflictError', 'GOAL_CHANGED'],
]);
function fallbackErrorStatus(statusCode, message) {
    if (typeof statusCode === 'number' && statusCode !== 500)
        return statusCode;
    if (/already exists/i.test(message))
        return 409;
    if (/not found/i.test(message))
        return 404;
    return 500;
}
function assertObjective(objective, maxChars) {
    const invalid = validateThreadGoalObjective(objective, maxChars);
    if (invalid) {
        throw new ThreadGoalContractError(400, invalid, maxChars !== undefined && objective.length > maxChars
            ? 'GOAL_OBJECTIVE_TOO_LONG'
            : 'VALIDATION_ERROR');
    }
}
/**
 * Coerce a wire `token_budget` (create path) into `number | null`: positive
 * integer = cap; `0` / omitted / non-positive = `null` (no cap).
 */
function budgetFromWire(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return null;
    return Math.floor(value);
}
function mapObjectiveResources(inputs) {
    return inputs.map((input) => {
        const resource = toKickoffAttachment({
            ...input,
            local: {
                ...input.local,
                dataUrl: input.local?.dataUrl || input.cloud?.dataUrl || input.cloud?.url,
            },
        });
        if (!resource)
            throw new ThreadGoalContractError(415, 'Local attachment source is unreadable or invalid', 'local_attachment_unreadable');
        return resource;
    });
}
function toKickoffAttachment(input) {
    const dataUrl = trimmedOrUndefined(input.local?.dataUrl);
    const assetId = trimmedOrUndefined(input.local?.assetId);
    const sourcePath = kickoffSourcePath(input.local, assetId, dataUrl);
    if (!sourcePath && !dataUrl)
        return undefined;
    return {
        type: input.meta?.attachmentType === 'image' ? 'image' : 'file',
        filePath: sourcePath,
        fileName: input.meta?.fileName ?? '',
        mimeType: input.meta?.mimeType ?? '',
        ...(dataUrl ? { dataUrl } : {}),
        ...(assetId ? { assetId } : {}),
    };
}
/**
 * `filePath` is also used as a display-oriented placeholder by clipboard and
 * inline-comment producers. Prefer a durable registered asset, then a real
 * desktop path. A remaining inline data URL must enter Queue admission with
 * an empty path so the existing attachment materializer persists it instead
 * of asking AgentHost to stat the synthetic display name.
 */
function kickoffSourcePath(local, assetId, dataUrl) {
    const filePath = local?.filePath?.trim() ?? '';
    const desktopPath = local?.desktopPath?.trim() ?? '';
    if (assetId && filePath)
        return filePath;
    return desktopPath || (isInlineDataUrl(dataUrl) ? '' : filePath);
}
function trimmedOrUndefined(value) {
    return value?.trim() || undefined;
}
function isInlineDataUrl(value) {
    return value?.toLowerCase().startsWith('data:') === true;
}
function toGoalAttachmentContractError(candidate, message, code) {
    const fields = {
        name: candidate.name,
        key: typeof candidate.key === 'string' ? candidate.key : undefined,
        reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
        code,
        message,
    };
    if (isTooLargeAttachmentError(fields)) {
        return new ThreadGoalContractError(413, 'Local attachment is too large to persist', 'local_attachment_too_large');
    }
    if (!isUnreadableAttachmentError(fields))
        return undefined;
    return new ThreadGoalContractError(415, 'Local attachment source is unreadable or invalid', 'local_attachment_unreadable');
}
function isTooLargeAttachmentError(fields) {
    return (fields.key === 'local_attachment_too_large' ||
        fields.code === 'local_attachment_too_large' ||
        (fields.name === 'AttachmentRegistrationError' && fields.reason === 'too-large') ||
        fields.message === 'asset_too_large' ||
        fields.message === 'Local attachment is too large to persist');
}
function isUnreadableAttachmentError(fields) {
    return (fields.key === 'local_attachment_unreadable' ||
        fields.code === 'local_attachment_unreadable' ||
        (fields.name === 'AttachmentRegistrationError' && fields.reason === 'unreadable') ||
        UNREADABLE_ATTACHMENT_MESSAGES.has(fields.message) ||
        (fields.code !== undefined && UNREADABLE_ATTACHMENT_CODES.has(fields.code)));
}
function requireNonEmpty(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ThreadGoalContractError(400, `${field} is required`, 'VALIDATION_ERROR');
    }
    return value;
}
//# sourceMappingURL=goal-contract.js.map