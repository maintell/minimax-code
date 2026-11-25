import { AppError } from '../errors.js';
import { PluginExtensionControllerBase } from '../generated/plugin-extension-controller-base.gen.js';
/** Facade failures the HTTP contract exposes; any other error becomes INTERNAL_ERROR. */
const FACADE_ERROR_STATUS = {
    EXTENSION_REQUEST_INVALID: 400,
    SESSION_NOT_FOUND: 404,
    /** An answer that came after the query settled; the renderer has nothing left to do. */
    EXTENSION_QUERY_UNKNOWN: 404,
    EXTENSION_DISABLED: 409,
    ACTIVATION_RETIRED: 409,
    INVOCATION_SETTLED: 409,
    VIEW_LEASE_HELD: 409,
    /** A plugin's gesture or menu-item hook threw, timed out or ran over budget. */
    EXTENSION_HOOK_FAILED: 422,
    GESTURE_QUEUE_FULL: 429,
    EXTENSION_HOST_CLOSED: 503,
    EXTENSION_WORKER_CRASHED: 503,
};
const NOT_CONFIGURED = {
    status: 503,
    key: 'EXTENSION_NOT_CONFIGURED',
    message: 'Plugin extensions are not available on this runtime host.',
};
export function createPluginExtensionController(facade) {
    return new PluginExtensionController(facade);
}
class PluginExtensionController extends PluginExtensionControllerBase {
    facade;
    constructor(facade) {
        super();
        this.facade = facade;
    }
    async listExtensionEntries(_ctx, req) {
        const facade = this.requireFacade();
        const sessionId = requireText(req.sessionId, 'session_id');
        return mapFacadeError(async () => toWireSnapshot(await facade.listEntries(sessionId)));
    }
    async renderExtension(ctx, req) {
        const facade = this.requireFacade();
        const input = {
            ...toSiteRef(req),
            surface: requireText(req.surface, 'surface'),
            viewLease: requireText(req.viewLease, 'view_lease'),
            ...(req.propsJson !== undefined ? { props: parseJson(req.propsJson, 'props_json') } : {}),
            ...(req.viewport ? { viewport: toViewport(req.viewport) } : {}),
            ...(req.epoch !== undefined ? { epoch: requireSequence(req.epoch, 'epoch') } : {}),
        };
        return mapFacadeError(async () => toWireRender(await facade.render(input, ctx.signal)));
    }
    async pressExtension(_ctx, req) {
        return this.gesture('press', req);
    }
    async inputExtension(_ctx, req) {
        return this.gesture('input', req);
    }
    async selectExtension(_ctx, req) {
        return this.gesture('select', req);
    }
    async ackExtensionApplied(_ctx, req) {
        const facade = this.requireFacade();
        const input = { ...toSiteRef(req), renderSeq: requireSequence(req.renderSeq, 'render_seq') };
        await mapFacadeError(() => facade.applied(input));
        return { ok: true };
    }
    async reportExtensionFallback(_ctx, req) {
        const facade = this.requireFacade();
        const input = {
            ...toSiteRef(req),
            renderSeq: requireSequence(req.renderSeq, 'render_seq'),
            path: requireString(req.path, 'path'),
            reason: requireText(req.reason, 'reason'),
        };
        await mapFacadeError(() => facade.report(input));
        return { ok: true };
    }
    async answerExtensionQuery(_ctx, req) {
        const facade = this.requireFacade();
        const input = {
            sessionId: requireText(req.sessionId, 'session_id'),
            requestId: requireText(req.requestId, 'request_id'),
            ...(req.composerSuggest
                ? {
                    composerSuggest: {
                        shown: req.composerSuggest.shown === true,
                        ...(req.composerSuggest.reason ? { reason: req.composerSuggest.reason } : {}),
                    },
                }
                : {}),
            ...(req.composerRead
                ? { composerRead: { draft: requireString(req.composerRead.draft, 'composer_read.draft') } }
                : {}),
            ...(req.composerFill
                ? {
                    composerFill: {
                        written: req.composerFill.written === true,
                        ...(req.composerFill.reason ? { reason: req.composerFill.reason } : {}),
                    },
                }
                : {}),
            ...(req.error ? { error: req.error } : {}),
        };
        await mapFacadeError(() => facade.answerQuery(input));
        return { ok: true };
    }
    /** The user closed a plugin's pane tab; the owning plugin's `ui.close` hooks observe it. */
    async closeExtensionPane(_ctx, req) {
        const facade = this.requireFacade();
        const input = {
            sessionId: requireText(req.sessionId, 'session_id'),
            pluginId: requireText(req.pluginId, 'plugin_id'),
            id: requireText(req.id, 'id'),
        };
        await mapFacadeError(() => facade.closePane(input));
        return { ok: true };
    }
    async subscribeExtensionStream(ctx, req) {
        if (!this.facade) {
            return {
                ok: false,
                status: NOT_CONFIGURED.status,
                body: {
                    code: NOT_CONFIGURED.status,
                    key: NOT_CONFIGURED.key,
                    message: NOT_CONFIGURED.message,
                },
            };
        }
        const facade = this.facade;
        const sessionId = requireText(req.sessionId, 'session_id');
        const events = await mapFacadeError(() => facade.openStream(sessionId, ctx.signal));
        return { ok: true, source: toWireFrames(events) };
    }
    async gesture(kind, req) {
        const facade = this.requireFacade();
        const input = toGestureInput(kind, req);
        const result = await mapFacadeError(() => facade.gesture(input));
        return 'stale' in result ? { ok: false, stale: true } : { ok: true };
    }
    requireFacade() {
        if (!this.facade) {
            throw new AppError(NOT_CONFIGURED.status, NOT_CONFIGURED.key, NOT_CONFIGURED.message);
        }
        return this.facade;
    }
}
function toSiteRef(req) {
    return {
        sessionId: requireText(req.sessionId, 'session_id'),
        slot: requireText(req.slot, 'slot'),
        key: requireText(req.key, 'key'),
    };
}
function toGestureInput(kind, req) {
    const base = { ...toSiteRef(req), kind, plugin: requireText(req.plugin, 'plugin') };
    if (req.renderSeq === undefined || req.handle === undefined) {
        throw invalidRequest('A gesture needs the render_seq and handle of a drawn element.');
    }
    return {
        ...base,
        renderSeq: requireSequence(req.renderSeq, 'render_seq'),
        handle: requireSequence(req.handle, 'handle'),
        ...(req.valueJson !== undefined ? { value: parseJson(req.valueJson, 'value_json') } : {}),
    };
}
function toViewport(viewport) {
    return {
        ...(viewport.width !== undefined
            ? { width: requireSequence(viewport.width, 'viewport.width') }
            : {}),
        ...(viewport.height !== undefined
            ? { height: requireSequence(viewport.height, 'viewport.height') }
            : {}),
    };
}
function toWireSnapshot(snapshot) {
    return {
        version: snapshot.version,
        viewLease: snapshot.viewLease,
        // No site binds tool results in phase one.
        toolResultBindings: [],
        disabled: snapshot.disabled.map((entry) => ({
            pluginId: entry.pluginId,
            ...(entry.slot !== undefined ? { slot: entry.slot } : {}),
            ...(entry.entry !== undefined ? { entry: entry.entry } : {}),
        })),
    };
}
function toWireRender(result) {
    switch (result.kind) {
        case 'tree':
            return {
                kind: 'tree',
                renderSeq: result.renderSeq,
                treeJson: JSON.stringify(result.tree),
                ...(result.coreProps !== undefined
                    ? { corePropsJson: JSON.stringify(result.coreProps) }
                    : {}),
            };
        case 'hostDefault':
            return {
                kind: 'hostDefault',
                renderSeq: result.renderSeq,
                corePropsJson: JSON.stringify(result.coreProps),
            };
        case 'error':
            return { kind: 'error', code: result.code, message: result.message };
    }
}
async function* toWireFrames(events) {
    for await (const event of events)
        yield toWireFrame(event);
}
function toWireFrame(event) {
    const frame = { kind: event.kind, timestamp: event.timestamp };
    switch (event.kind) {
        case 'heartbeat':
            return frame;
        case 'invalidate':
            return { ...frame, invalidate: { slot: event.slot, key: event.key } };
        case 'entries-changed':
            return { ...frame, entriesChanged: { version: event.version } };
        case 'toast':
            return {
                ...frame,
                toast: {
                    pluginId: event.pluginId,
                    text: event.text,
                    ...(event.tone !== undefined ? { tone: event.tone } : {}),
                },
            };
        case 'ui.open':
            return { ...frame, uiOpen: toWireUiOpen(event) };
        case 'ui.close':
            return { ...frame, uiClose: { pluginId: event.pluginId, id: event.id } };
        case 'pane.snapshot':
            return {
                ...frame,
                paneSnapshot: {
                    panes: event.panes.map(({ pluginId, id, title }) => ({ pluginId, id, title })),
                },
            };
        case 'query':
            return { ...frame, query: toWireQuery(event) };
    }
}
function toWireUiOpen(event) {
    return {
        pluginId: event.pluginId,
        id: event.id,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.focus !== undefined ? { focus: event.focus } : {}),
    };
}
function toWireQuery(event) {
    return {
        requestId: event.requestId,
        sessionId: event.sessionId,
        op: event.op,
        ...(event.composerSuggest ? { composerSuggest: event.composerSuggest } : {}),
        ...(event.composerFill ? { composerFill: event.composerFill } : {}),
    };
}
async function mapFacadeError(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof AppError)
            throw error;
        const known = knownFacadeError(error);
        if (known) {
            throw new AppError(known.status, known.code, known.message, known.code === 'GESTURE_QUEUE_FULL' ? true : undefined);
        }
        throw new AppError(500, 'INTERNAL_ERROR', 'internal error');
    }
}
function knownFacadeError(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const { code, message } = error;
    if (typeof code !== 'string')
        return undefined;
    const status = FACADE_ERROR_STATUS[code];
    if (status === undefined)
        return undefined;
    return { status, code, message: typeof message === 'string' && message ? message : code };
}
function requireText(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw invalidRequest(`${field} is required.`);
    }
    return value;
}
function requireString(value, field) {
    if (typeof value !== 'string')
        throw invalidRequest(`${field} must be a string.`);
    return value;
}
function requireSequence(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw invalidRequest(`${field} must be a non-negative integer.`);
    }
    return value;
}
function parseJson(text, field) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw invalidRequest(`${field} must be valid JSON.`);
    }
}
function invalidRequest(message) {
    return new AppError(400, 'EXTENSION_REQUEST_INVALID', message);
}
//# sourceMappingURL=plugin-extension.controller.js.map