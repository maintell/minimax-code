import { PreferenceControllerBase } from '../generated/preference-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
import { HTTPException } from 'hono/http-exception';
import { GLOBAL_INSTRUCTIONS_MAX_BYTES, GlobalInstructionsError, } from '../../service/turn-system/index.js';
import { ComputerUsePreferenceError, } from '../../service/computer-use/index.js';
function isComposerSendBehavior(value) {
    return value === 'queue' || value === 'steer';
}
function isComposerEnterBehavior(value) {
    return value === 'enter' || value === 'cmdIfMultiline' || value === 'cmdAlways';
}
export class PreferenceController extends PreferenceControllerBase {
    options;
    constructor(options = {}) {
        super();
        this.options = options;
    }
    async getComputerUseDefaultPreference(_ctx, _req) {
        return this.mapComputerUsePreferenceErrors(() => this.requireComputerUsePreference().get());
    }
    async putComputerUseDefaultPreference(_ctx, req) {
        if (typeof req.enabled !== 'boolean') {
            throw new AppError(400, 'INVALID_COMPUTER_USE_PREFERENCE', 'enabled must be a boolean');
        }
        return this.mapComputerUsePreferenceErrors(() => this.requireComputerUsePreference().set(req.enabled));
    }
    requireComputerUsePreference() {
        if (!this.options.computerUseDefaultPreference) {
            throw new AppError(503, 'COMPUTER_USE_UNAVAILABLE', 'Computer Use is unavailable on this host');
        }
        return this.options.computerUseDefaultPreference;
    }
    async mapComputerUsePreferenceErrors(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof ComputerUsePreferenceError) {
                throw new AppError(error.code === 'SCOPE_UNAVAILABLE' ? 401 : 409, `COMPUTER_USE_${error.code}`, error.message);
            }
            if (error instanceof AppError)
                throw error;
            throw new AppError(500, 'COMPUTER_USE_PREFERENCE_FAILED', 'Computer Use preference operation failed');
        }
    }
    async getComposerSendBehavior(ctx, req) {
        void ctx;
        void req;
        if (!this.options.composerSendBehavior)
            throw new NotImplementedError('getComposerSendBehavior');
        return { behavior: await this.options.composerSendBehavior.get() };
    }
    async putComposerSendBehavior(ctx, req) {
        void ctx;
        if (!this.options.composerSendBehavior)
            throw new NotImplementedError('putComposerSendBehavior');
        const behavior = req.behavior;
        if (!isComposerSendBehavior(behavior)) {
            throw new AppError(400, 'INVALID_COMPOSER_SEND_BEHAVIOR', `composer send behavior must be "queue" or "steer", got ${JSON.stringify(behavior)}`);
        }
        await this.options.composerSendBehavior.set(behavior);
        return { behavior };
    }
    async getComposerEnterBehavior(ctx, req) {
        void ctx;
        void req;
        if (!this.options.composerEnterBehavior)
            throw new NotImplementedError('getComposerEnterBehavior');
        return { behavior: await this.options.composerEnterBehavior.get() };
    }
    async putComposerEnterBehavior(ctx, req) {
        void ctx;
        if (!this.options.composerEnterBehavior)
            throw new NotImplementedError('putComposerEnterBehavior');
        const behavior = req.behavior;
        if (!isComposerEnterBehavior(behavior)) {
            throw new AppError(400, 'INVALID_COMPOSER_ENTER_BEHAVIOR', `composer enter behavior must be "enter", "cmdIfMultiline" or "cmdAlways", got ${JSON.stringify(behavior)}`);
        }
        await this.options.composerEnterBehavior.set(behavior);
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
        return this.requireWorkspaceIndexing('getWorkspaceIndexingPreference').getPreference();
    }
    async putWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        return this.requireWorkspaceIndexing('putWorkspaceIndexingPreference').setEnabled(req.enabled);
    }
    requireGlobalInstructions(method) {
        if (!this.options.globalInstructions)
            throw new NotImplementedError(method);
        return this.options.globalInstructions;
    }
    requireWorkspaceIndexing(method) {
        if (!this.options.workspaceIndexing)
            throw new NotImplementedError(method);
        return this.options.workspaceIndexing;
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