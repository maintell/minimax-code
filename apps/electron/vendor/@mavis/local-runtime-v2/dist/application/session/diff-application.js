import { SessionDiffServiceError, } from '../../service/session-system/index.js';
import { AppError } from '../errors.js';
/** Owns Diff eligibility, selector mapping, and generated mutation response shapes. */
export class SessionDiffApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async getSessionDiff(_context, req) {
        return this.options.capability.getSessionDiff(await this.requireTarget(req.id), req.messageId);
    }
    async getTurnDiff(_context, req) {
        await this.requireTarget(req.id);
        return this.options.capability.getTurnDiff(req.id, selectorFromRequest(req));
    }
    async revertTurnDiff(_context, req) {
        await this.requireTarget(req.id);
        const result = await this.options.capability.mutateTurnDiff(req.id, 'revert', selectorFromRequest(req));
        assertMutationSucceeded(result);
        return {
            success: result.body.success,
            error: result.body.error,
            turnDiff: toTurnDiffView(result.body),
        };
    }
    async reapplyTurnDiff(_context, req) {
        await this.requireTarget(req.id);
        const result = await this.options.capability.mutateTurnDiff(req.id, 'reapply', selectorFromRequest(req));
        assertMutationSucceeded(result);
        const { success, error, ...diff } = result.body;
        return { success, error, ...diff };
    }
    async requireTarget(sessionId) {
        try {
            return await this.options.service.requireTarget(sessionId);
        }
        catch (error) {
            if (!(error instanceof SessionDiffServiceError))
                throw error;
            throw new AppError(error.reason === 'session-not-found' ? 404 : 409, error.reason === 'session-not-found' ? 'SESSION_NOT_FOUND' : 'OPENCODE_DIFF_UNAVAILABLE', error.message);
        }
    }
}
function selectorFromRequest(input) {
    return {
        ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.changeSetId ? { changeSetId: input.changeSetId } : {}),
    };
}
function assertMutationSucceeded(result) {
    if (result.status === 200)
        return;
    throw new AppError(result.status, result.status === 404 ? 'TURN_DIFF_NOT_FOUND' : 'TURN_DIFF_CONFLICT', result.body.error ?? 'Turn diff mutation failed');
}
function toTurnDiffView(body) {
    const view = {
        ...whenDefined('fileChanges', body.fileChanges),
        ...whenDefined('sourceMessageId', body.sourceMessageId),
        ...whenDefined('changeSetId', body.changeSetId),
        ...whenDefined('status', body.status),
        ...whenDefined('revertedAt', body.revertedAt),
        ...whenDefined('undoable', body.undoable),
        ...whenDefined('canUndo', body.canUndo),
        ...whenDefined('canReapply', body.canReapply),
    };
    if ((view.fileChanges?.length ?? 0) === 0 &&
        !view.sourceMessageId &&
        !view.changeSetId &&
        !view.status) {
        return undefined;
    }
    return view;
}
function whenDefined(key, value) {
    return value === undefined ? {} : { [key]: value };
}
//# sourceMappingURL=diff-application.js.map