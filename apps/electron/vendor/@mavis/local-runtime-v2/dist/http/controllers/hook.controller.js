import { LocalHookScope, LocalHookSource } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../errors.js';
import { HookControllerBase } from '../generated/hook-controller-base.gen.js';
import { HookConfigError, } from '../../service/hook-config/index.js';
export function createHookController(service) {
    return new HookController(service);
}
class HookController extends HookControllerBase {
    service;
    constructor(service) {
        super();
        this.service = service;
    }
    async listLocalHooks(_ctx, req) {
        return this.map(async () => toWireList(await this.requireService().list(toScopeRef(req))));
    }
    async createLocalHook(_ctx, req) {
        return this.map(async () => {
            const result = await this.requireService().create(toScopeRef(req), req.expectedRevision, fromWireDefinition(req.definition));
            return { ...toWireList(result), hookId: result.hookId };
        });
    }
    async updateLocalHook(_ctx, req) {
        return this.map(async () => {
            const result = await this.requireService().update(toScopeRef(req), req.hookId, req.expectedRevision, fromWireDefinition(req.definition));
            return { ...toWireList(result), hookId: result.hookId };
        });
    }
    async deleteLocalHook(_ctx, req) {
        return this.map(async () => toWireList(await this.requireService().delete(toScopeRef(req), req.hookId, req.expectedRevision)));
    }
    async setLocalHookEnabled(_ctx, req) {
        return this.map(async () => toWireList(await this.requireService().setHookEnabled(toScopeRef(req), req.hookId, req.enabled, req.expectedRevision)));
    }
    async setLocalHookScopeEnabled(_ctx, req) {
        return this.map(async () => toWireList(await this.requireService().setScopeEnabled(toScopeRef(req), req.enabled, req.expectedRevision)));
    }
    requireService() {
        if (!this.service)
            throw new AppError(503, 'LOCAL_HOOK_UNAVAILABLE', 'Hook settings unavailable');
        return this.service;
    }
    async map(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            if (error instanceof HookConfigError) {
                throw new AppError(error.status, error.code, error.message);
            }
            throw new AppError(500, 'INTERNAL_ERROR', 'internal error');
        }
    }
}
function toScopeRef(req) {
    const scope = Number(req.scope);
    if (scope === LocalHookScope.USER)
        return { scope: 'user' };
    if (scope === LocalHookScope.PROJECT && req.projectDir) {
        return { scope: 'project', projectDir: req.projectDir };
    }
    throw new AppError(400, 'LOCAL_HOOK_SCOPE_INVALID', 'Hook scope or project is missing.');
}
function fromWireDefinition(definition) {
    if (!definition) {
        throw new AppError(400, 'LOCAL_HOOK_DEFINITION_INVALID', 'Hook definition is required.');
    }
    return {
        event: definition.event,
        command: definition.command,
        ...(definition.matcher !== undefined ? { matcher: definition.matcher } : {}),
        ...(definition.commandWindows !== undefined
            ? { commandWindows: definition.commandWindows }
            : {}),
        ...(definition.timeoutSeconds !== undefined
            ? { timeoutSeconds: definition.timeoutSeconds }
            : {}),
        ...(definition.name !== undefined ? { name: definition.name } : {}),
    };
}
function toWireList(view) {
    const { config } = view;
    return {
        config: {
            scope: config.scope === 'user' ? LocalHookScope.USER : LocalHookScope.PROJECT,
            ...(config.projectDir ? { projectDir: config.projectDir } : {}),
            configPath: config.configPath,
            exists: config.exists,
            revision: config.revision,
            enabled: config.enabled,
            ...(config.errorCode ? { errorCode: config.errorCode } : {}),
            ...(config.errorMessage ? { errorMessage: config.errorMessage } : {}),
        },
        hooks: view.hooks.map(toWireItem),
    };
}
const WIRE_HOOK_SOURCE = {
    user: LocalHookSource.USER,
    project: LocalHookSource.PROJECT,
};
function toWireItem(entry) {
    const { definition } = entry;
    return {
        hookId: entry.hookId,
        source: WIRE_HOOK_SOURCE[entry.source],
        definition: {
            event: definition.event,
            command: definition.command,
            ...(definition.matcher ? { matcher: definition.matcher } : {}),
            ...(definition.commandWindows ? { commandWindows: definition.commandWindows } : {}),
            ...(definition.timeoutSeconds !== undefined
                ? { timeoutSeconds: definition.timeoutSeconds }
                : {}),
            ...(definition.name ? { name: definition.name } : {}),
        },
        enabled: entry.enabled,
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    };
}
//# sourceMappingURL=hook.controller.js.map