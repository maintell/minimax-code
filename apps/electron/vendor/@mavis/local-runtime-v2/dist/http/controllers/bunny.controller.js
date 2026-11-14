import { isBunnyPermissionMode, BunnyBackupNotFoundError, BunnyTaskModelInvalidError, } from '../../service/bunny/index.js';
import { WorkingStateError, } from '../../service/working-state/index.js';
import { toAssignmentStateView } from '../../application/session/wire.js';
import { BunnyControllerBase } from '../generated/bunny-controller-base.gen.js';
import { AppError } from '../errors.js';
const BUNNY_UNAVAILABLE = 'Bunny is unavailable';
const ASSIGNMENTS_UNAVAILABLE = 'Assignments are unavailable';
export class BunnyController extends BunnyControllerBase {
    bunny;
    assignments;
    workingState;
    trace;
    store;
    taskTelemetry;
    constructor(owners = {}) {
        super();
        this.bunny = owners.bunny;
        this.assignments = owners.assignments;
        this.workingState = owners.workingState;
        this.trace = owners.trace;
        this.store = owners.store;
        this.taskTelemetry = owners.taskTelemetry;
    }
    // "近期约定": the user's side of the working-state ledger; every write is author=user.
    listWorkingStateEntries(_context, request) {
        return this.withWorkingState((ledger) => ({
            entries: ledger.list(request).map(toWorkingStateEntryView),
            revision: ledger.revision(),
        }), { entries: [], revision: 0 });
    }
    addWorkingStateEntry(_context, request) {
        return this.withWorkingState((ledger) => ({
            entry: toWorkingStateEntryView(ledger.add({
                kind: request.kind,
                text: request.text,
                scope: request.scope,
                replaces: request.replaces,
                expiresAtMs: request.expiresAtMs === undefined ? undefined : Number(request.expiresAtMs),
            }, 'user')),
        }));
    }
    updateWorkingStateEntry(_context, request) {
        return this.withWorkingState((ledger) => ({
            entry: toWorkingStateEntryView(ledger.update({
                id: request.id,
                text: request.text,
                ...(request.replaces === undefined ? {} : { replaces: request.replaces || null }),
                ...(request.expiresAtMs === undefined
                    ? {}
                    : { expiresAtMs: Number(request.expiresAtMs) }),
            }, 'user')),
        }));
    }
    closeWorkingStateEntry(_context, request) {
        return this.withWorkingState((ledger) => ({
            entry: toWorkingStateEntryView(ledger.close(request.id, request.reason, 'user')),
        }));
    }
    confirmWorkingStateEntry(_context, request) {
        return this.withWorkingState((ledger) => ({
            entry: toWorkingStateEntryView(ledger.confirm(request.id)),
        }));
    }
    /** `whenNothingStored` answers a read while the store holds nothing, without opening it. */
    async withWorkingState(run, whenNothingStored) {
        const unavailable = 'Bunny working state is unavailable';
        const ledger = this.requireOwner(this.workingState, 'BUNNY_UNAVAILABLE', unavailable);
        if (whenNothingStored !== undefined && this.nothingStored())
            return whenNothingStored;
        try {
            return await this.persisted('BUNNY_UNAVAILABLE', unavailable, () => run(ledger));
        }
        catch (error) {
            if (error instanceof WorkingStateError)
                throw new AppError(error.status, error.code, error.message);
            throw error;
        }
    }
    // Developer Tools: the Bunny trace recorded for one session, newest first (spec 17.1).
    async listBunnyTraceEvents(_context, request) {
        const trace = this.requireOwner(this.trace, 'BUNNY_UNAVAILABLE', 'Bunny trace is unavailable');
        if (!request.sessionId?.trim())
            throw new AppError(400, 'INVALID_ARGUMENTS', 'session_id is required');
        if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'limit must be a positive integer');
        return { events: trace.list(request.sessionId, request.limit) };
    }
    async listBunnyTaskTelemetry(_context, request) {
        const owner = this.requireOwner(this.taskTelemetry, 'BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE);
        if (request.limit !== undefined &&
            (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'limit must be between 1 and 200');
        if (this.nothingStored())
            return { events: [] };
        return this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, () => ({
            events: owner.pending(request.limit),
        }));
    }
    async ackBunnyTaskTelemetry(_context, request) {
        const owner = this.requireOwner(this.taskTelemetry, 'BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE);
        if (!Array.isArray(request.eventIds) ||
            request.eventIds.length > 200 ||
            request.eventIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 512))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'event_ids must contain at most 200 event IDs');
        if (this.nothingStored())
            return {};
        return this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, () => {
            owner.acknowledge(request.eventIds);
            return {};
        });
    }
    ensureBunny(_context, _request) {
        // Entering Bunny is its first use: open the store before anything else, so a store that
        // cannot be opened answers 503 before Bunny creates its Session, files or settings.
        this.store?.open();
        return this.requireBunny().ensure();
    }
    async reportBunnyViewState(_context, request) {
        const bunny = this.requireBunny();
        if (typeof request.panelOpen !== 'boolean')
            throw new AppError(400, 'INVALID_ARGUMENTS', 'panel_open must be boolean');
        bunny.reportViewState({ panelOpen: request.panelOpen, spaceId: request.spaceId });
        return {};
    }
    resetBunny(_context, _request) {
        const bunny = this.requireBunny();
        return this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, () => bunny.reset());
    }
    async listBunnyBackups(_context, _request) {
        const backups = await this.requireBunny().listBackups();
        return {
            backups: backups.map(({ createdAtMs, ...backup }) => ({ ...backup, createdAt: createdAtMs })),
        };
    }
    async restoreBunnyBackup(_context, request) {
        const bunny = this.requireBunny();
        if (typeof request.backupId !== 'string' || !request.backupId.trim())
            throw new AppError(400, 'INVALID_ARGUMENTS', 'backup_id is required');
        try {
            return await this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, () => bunny.restore(request.backupId.trim()));
        }
        catch (error) {
            if (error instanceof BunnyBackupNotFoundError)
                throw new AppError(404, error.code, error.message);
            throw error;
        }
    }
    async setBunnyPermissionMode(_context, request) {
        const bunny = this.requireBunny();
        if (!isBunnyPermissionMode(request.mode))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'mode must be follow, default, auto or bypassPermissions');
        const mode = request.mode;
        return this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, async () => ({
            mode: await bunny.setPermissionMode(mode),
        }));
    }
    async setBunnyTaskModel(_context, request) {
        const bunny = this.requireBunny();
        const model = request.model;
        if (model &&
            (!model.providerId.trim() ||
                !model.modelId.trim() ||
                (model.effort !== undefined && !model.effort.trim()) ||
                (model.contextLimit !== undefined &&
                    (!Number.isSafeInteger(model.contextLimit) || model.contextLimit <= 0))))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'Invalid task model');
        return this.persisted('BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE, async () => ({
            model: await saveTaskModel(bunny, model),
        }));
    }
    async setAssignmentCompletion(_context, request) {
        const assignments = this.requireAssignments();
        if (!request.sessionId.trim() ||
            (request.state !== 'completed' && request.state !== 'cancelled'))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'session_id and state are invalid');
        try {
            const state = request.state;
            const assignment = await this.persisted('ASSIGNMENTS_UNAVAILABLE', ASSIGNMENTS_UNAVAILABLE, () => assignments.setCompletion({ sessionId: request.sessionId, state, by: 'user' }));
            return { assignment: toAssignmentStateView(assignment) };
        }
        catch (error) {
            if (error instanceof Error && Reflect.get(error, 'code') === 'ASSIGNMENT_CANCEL_PENDING')
                throw new AppError(409, 'ASSIGNMENT_CANCEL_PENDING', error.message);
            throw error;
        }
    }
    async listAgentAssignments(_context, request) {
        const assignments = this.requireAssignments();
        if (!request.name.trim() ||
            (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)))
            throw new AppError(400, 'INVALID_ARGUMENTS', 'name and limit are invalid');
        // Every task lives in the Bunny store; with nothing stored there is none.
        if (this.nothingStored())
            return { assignments: [] };
        const listed = await assignments.list(request.name, request.limit);
        return { assignments: listed.map(toAssignmentStateView) };
    }
    requireBunny() {
        return this.requireOwner(this.bunny, 'BUNNY_UNAVAILABLE', BUNNY_UNAVAILABLE);
    }
    requireAssignments() {
        return this.requireOwner(this.assignments, 'ASSIGNMENTS_UNAVAILABLE', ASSIGNMENTS_UNAVAILABLE);
    }
    /** A store that could not be opened this run answers as a missing owner does. */
    requireOwner(owner, code, message) {
        if (!owner || this.store?.unavailable !== undefined)
            throw new AppError(503, code, message);
        return owner;
    }
    /** Bunny off and nothing stored: the store is not open and has no file. */
    nothingStored() {
        return this.store !== undefined && !this.store.hasData();
    }
    /**
     * A write that was the store's first use this run: when that opening failed, the write went
     * to the in-memory stand-in, so it answers 503 instead of a success a restart would lose.
     */
    async persisted(code, message, write) {
        const result = await write();
        if (this.store?.unavailable !== undefined)
            throw new AppError(503, code, message);
        return result;
    }
}
function toWorkingStateEntryView(entry) {
    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        text: entry.text,
        ...(entry.replaces ? { replaces: entry.replaces } : {}),
        ...(entry.expiresAtMs === undefined ? {} : { expiresAtMs: entry.expiresAtMs }),
        ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
        status: entry.status,
        ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
        ...(entry.source?.sessionId ? { sourceSessionId: entry.source.sessionId } : {}),
        ...(entry.source
            ? { sourceMessageId: entry.source.messageId, sourceAtMs: entry.source.atMs }
            : {}),
        author: entry.author,
        inferred: entry.inferred,
        createdAtMs: entry.createdAtMs,
        updatedAtMs: entry.updatedAtMs,
        ...(entry.closedAtMs === undefined ? {} : { closedAtMs: entry.closedAtMs }),
    };
}
/** A task model the Runtime cannot resolve is refused with its reason, not saved. */
async function saveTaskModel(bunny, model) {
    try {
        return await bunny.setTaskModel(model);
    }
    catch (error) {
        if (error instanceof BunnyTaskModelInvalidError)
            throw new AppError(400, error.code, error.message);
        throw error;
    }
}
//# sourceMappingURL=bunny.controller.js.map