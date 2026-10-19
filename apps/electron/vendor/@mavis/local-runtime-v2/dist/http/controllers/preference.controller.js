import { PreferenceControllerBase } from '../generated/preference-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
import { HTTPException } from 'hono/http-exception';
import { GLOBAL_INSTRUCTIONS_MAX_BYTES, GlobalInstructionsError, } from '../../service/turn-system/index.js';
function isComposerSendBehavior(value) {
    return value === 'queue' || value === 'steer';
}
function isComposerEnterBehavior(value) {
    return value === 'enter' || value === 'cmdIfMultiline' || value === 'cmdAlways';
}
export class PreferenceController extends PreferenceControllerBase {
    globalInstructions;
    workspaceIndexing;
    composerSendBehavior;
    composerEnterBehavior;
    constructor(globalInstructions, workspaceIndexing, composerSendBehavior, composerEnterBehavior) {
        super();
        this.globalInstructions = globalInstructions;
        this.workspaceIndexing = workspaceIndexing;
        this.composerSendBehavior = composerSendBehavior;
        this.composerEnterBehavior = composerEnterBehavior;
    }
    async getComposerSendBehavior(ctx, req) {
        void ctx;
        void req;
        if (!this.composerSendBehavior)
            throw new NotImplementedError('getComposerSendBehavior');
        return { behavior: await this.composerSendBehavior.get() };
    }
    async putComposerSendBehavior(ctx, req) {
        void ctx;
        if (!this.composerSendBehavior)
            throw new NotImplementedError('putComposerSendBehavior');
        const behavior = req.behavior;
        if (!isComposerSendBehavior(behavior)) {
            throw new AppError(400, 'INVALID_COMPOSER_SEND_BEHAVIOR', `composer send behavior must be "queue" or "steer", got ${JSON.stringify(behavior)}`);
        }
        await this.composerSendBehavior.set(behavior);
        return { behavior };
    }
    async getComposerEnterBehavior(ctx, req) {
        void ctx;
        void req;
        if (!this.composerEnterBehavior)
            throw new NotImplementedError('getComposerEnterBehavior');
        return { behavior: await this.composerEnterBehavior.get() };
    }
    async putComposerEnterBehavior(ctx, req) {
        void ctx;
        if (!this.composerEnterBehavior)
            throw new NotImplementedError('putComposerEnterBehavior');
        const behavior = req.behavior;
        if (!isComposerEnterBehavior(behavior)) {
            throw new AppError(400, 'INVALID_COMPOSER_ENTER_BEHAVIOR', `composer enter behavior must be "enter", "cmdIfMultiline" or "cmdAlways", got ${JSON.stringify(behavior)}`);
        }
        await this.composerEnterBehavior.set(behavior);
        return { behavior };
    }
    async getGlobalInstructions(ctx, req) {
        void ctx;
        void req;
        return this.mapGlobalInstructionsErrors(() => this.requireGlobalInstructions('getGlobalInstructions').read());
    }
    async putGlobalInstructions(ctx, req) {
        void ctx;
        return this.mapGlobalInstructionsErrors(() => this.requireGlobalInstructions('putGlobalInstructions').write(req.content));
    }
    async getWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        void req;
        return this.requireWorkspaceIndexing('getWorkspaceIndexingPreference').get();
    }
    async putWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        return this.requireWorkspaceIndexing('putWorkspaceIndexingPreference').put(req.enabled);
    }
    requireGlobalInstructions(method) {
        if (!this.globalInstructions)
            throw new NotImplementedError(method);
        return this.globalInstructions;
    }
    requireWorkspaceIndexing(method) {
        if (!this.workspaceIndexing)
            throw new NotImplementedError(method);
        return this.workspaceIndexing;
    }
    async mapGlobalInstructionsErrors(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (!(error instanceof GlobalInstructionsError))
                throw error;
            if (error.code === 'GLOBAL_INSTRUCTIONS_TOO_LARGE') {
                throw new HTTPException(400, {
                    res: new Response(JSON.stringify({
                        error: 'Global instructions exceed the UTF-8 byte limit',
                        code: error.code,
                        maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES,
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
                });
            }
            throw new HTTPException(500, {
                res: new Response(JSON.stringify({
                    error: error.code === 'GLOBAL_INSTRUCTIONS_READ_FAILED'
                        ? 'Failed to read global instructions'
                        : 'Failed to write global instructions',
                    code: error.code,
                }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
            });
        }
    }
}
//# sourceMappingURL=preference.controller.js.map