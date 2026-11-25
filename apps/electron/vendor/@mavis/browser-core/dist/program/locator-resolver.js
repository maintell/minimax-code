import { describeCdpException, describeUnresolvedBrowserRef, isRecord, resolveBrowserSnapshotElement, } from '../browser-state.js';
import { isBrowserOperationInterruption } from '../operation-timeout.js';
import { BrowserProgramError } from './errors.js';
import { PROGRAM_PAGE_SOURCE, programPageExpression, } from './page-script.js';
function commandOptions(state) {
    return {
        ...(state.commandSignal ? { signal: state.commandSignal } : {}),
        ...(state.commandTimeoutMs ? { timeoutMs: state.commandTimeoutMs } : {}),
    };
}
function pageResponse(payload) {
    if (payload.exceptionDetails) {
        throw new Error(describeCdpException(payload.exceptionDetails, 'Page operation failed'));
    }
    const value = payload.result?.value;
    return value && typeof value === 'object' ? value : { ok: false };
}
/** One request in the main frame or in one out-of-process frame's session. */
export async function callProgramPage(state, request, options = {}) {
    return pageResponse(await state.transport.send('Runtime.evaluate', {
        expression: programPageExpression(request, options.selectMutation),
        awaitPromise: true,
        returnByValue: true,
    }, options.sessionId, commandOptions(state)));
}
/**
 * A ref from observe or inspect: its backend node runs the rest of the chain.
 * A node inside a frame runs in that frame's realm, so a probe's point is in
 * the frame's viewport (`frameLocal`); it is moved into the main viewport by
 * where the frame sits now. When that cannot be measured the answer keeps
 * `frameLocal`, and a pointer action must not use its point.
 */
async function callAtRef(state, ref, request, selectMutation) {
    const resolved = resolveBrowserSnapshotElement(state, ref);
    if (!resolved)
        throw new Error(describeUnresolvedBrowserRef(state, ref));
    const { element } = resolved;
    return framePointerChecked(state, request, async (attempt) => {
        const response = await callAtBackendNode(state, element.backendNodeId, attempt, {
            ...(element.commandSessionId ? { sessionId: element.commandSessionId } : {}),
            ...(selectMutation ? { selectMutation } : {}),
        });
        if (response.frameLocal !== true || typeof response.x !== 'number') {
            return { response, framed: false };
        }
        const origin = await refFrameOrigin(state, element).catch((error) => {
            if (isBrowserOperationInterruption(error))
                throw error;
            return undefined;
        });
        return { response: inMainViewport(response, origin), framed: true };
    }, () => refFrameOwner(state, element));
}
/**
 * A frame realm's probe judged its point against the frame's own viewport.
 * Moved into the main viewport, the point can still be off screen (a frame
 * below the fold) or on an element of the page drawn over the frame, so the
 * main frame hit-tests it at the frame's owner element. Off screen, the target
 * is scrolled into view from its own realm, which scrolls the frames around it
 * too, and measured once more; a point still off screen or covered is refused
 * as `outside_viewport` or `covered`, never clicked.
 */
async function framePointerChecked(state, request, measure, frameOwner) {
    let { response, framed } = await measure(request);
    const checks = isRecord(request.checks) ? request.checks : undefined;
    if (request.kind !== 'probe' || checks?.pointer !== true)
        return response;
    for (let revealed = false;; revealed = true) {
        if (!framed || response.ok !== true || typeof response.x !== 'number')
            return response;
        const owner = await frameOwner().catch((error) => {
            if (isBrowserOperationInterruption(error))
                throw error;
            return undefined;
        });
        if (owner === undefined)
            return response;
        const hit = await mainViewportHit(state, owner, response.x, response.y).catch((error) => {
            if (isBrowserOperationInterruption(error))
                throw error;
            return { ok: true };
        });
        if (hit.ok === true)
            return response;
        if (hit.reason !== 'outside_viewport' || revealed) {
            return {
                reason: hit.reason === 'outside_viewport' ? 'outside_viewport' : 'covered',
                ...(typeof hit.coveredBy === 'string' ? { coveredBy: hit.coveredBy } : {}),
                ...(typeof response.href === 'string' ? { href: response.href } : {}),
            };
        }
        ({ response, framed } = await measure({ ...request, checks: { ...checks, reveal: true } }));
    }
}
/**
 * Whether a main-viewport point is on screen and reaches the frame held by the
 * owner element `owner`. The owner's realm checks it through the frame
 * elements above it; when a frame of another origin sits in between (another
 * origin on the same site, or a sandboxed frame), that realm cannot reach the
 * top document, and the main frame's CDP hit test answers instead.
 */
async function mainViewportHit(state, owner, x, y) {
    const hit = await callAtBackendNode(state, owner, { kind: 'mainHit', chain: [], x, y });
    if (hit.reason !== 'unreachable')
        return hit;
    return cdpMainViewportHit(state, owner, Number(x), Number(y));
}
/**
 * The main frame's hit test through CDP, which goes down through the page's
 * in-process frames whatever their origin: the point must be on screen and
 * land on the owner element (the frame it holds runs in another process), not
 * on anything drawn over it.
 */
async function cdpMainViewportHit(state, owner, x, y) {
    const metrics = await state.transport.send('Page.getLayoutMetrics', {}, undefined, commandOptions(state));
    const viewport = metrics.cssLayoutViewport;
    if (typeof viewport?.clientWidth !== 'number' || typeof viewport.clientHeight !== 'number') {
        return { ok: true };
    }
    if (!(x >= 0 && y >= 0 && x < viewport.clientWidth && y < viewport.clientHeight)) {
        return { reason: 'outside_viewport' };
    }
    // DOM.getNodeForLocation takes document coordinates: the viewport point plus the scroll.
    const hit = await state.transport.send('DOM.getNodeForLocation', {
        x: Math.round(x + (viewport.pageX ?? 0)),
        y: Math.round(y + (viewport.pageY ?? 0)),
        includeUserAgentShadowDOM: false,
    }, undefined, commandOptions(state));
    return hit.backendNodeId === owner ? { ok: true } : { reason: 'covered' };
}
/** The owner element, in the main frame's document, of the outermost frame holding a ref's element. */
async function refFrameOwner(state, element) {
    const sessionId = element.commandSessionId;
    if (!sessionId)
        return element.frameId ? frameOwnerNode(state, element.frameId) : undefined;
    const frames = state.transport.listAttachedFrames?.() ?? [];
    const attached = frames.find((frame) => frame.sessionId === sessionId);
    return attached ? attachedFrameOwner(state, attached, frames) : undefined;
}
/** The main frame's owner element of the out-of-process frame chain a frame is in. */
async function attachedFrameOwner(state, frame, frames) {
    let outer = frame;
    while (outer.parentSessionId) {
        const parent = frames.find((candidate) => candidate.sessionId === outer.parentSessionId);
        if (!parent)
            return undefined;
        outer = parent;
    }
    return frameOwnerNode(state, outer.frameId);
}
async function frameOwnerNode(state, frameId) {
    const owner = await state.transport.send('DOM.getFrameOwner', { frameId }, undefined, commandOptions(state));
    return owner.backendNodeId;
}
/**
 * Where the viewport of the frame holding a ref's element sits in the main
 * viewport: the out-of-process frame its session addresses, plus the
 * in-process frame inside it when the element is in one.
 */
async function refFrameOrigin(state, element) {
    const sessionId = element.commandSessionId;
    const frames = state.transport.listAttachedFrames?.() ?? [];
    const attached = sessionId ? frames.find((frame) => frame.sessionId === sessionId) : undefined;
    if (sessionId && !attached)
        return undefined;
    const sessionOrigin = attached
        ? await attachedFrameOffset(state, attached, frames)
        : { x: 0, y: 0 };
    if (!sessionOrigin)
        return undefined;
    if (attached && attached.frameId === element.frameId)
        return sessionOrigin;
    if (!element.frameId)
        return undefined;
    const inner = await frameContentOrigin(state, element.frameId, sessionId);
    return inner && { x: sessionOrigin.x + inner.x, y: sessionOrigin.y + inner.y };
}
/**
 * One request with a known DOM node as the chain's start (`this`): a ref's
 * element, or the node an action already resolved.
 */
export async function callAtBackendNode(state, backendNodeId, request, options = {}) {
    const { sessionId } = options;
    const node = await state.transport
        .send('DOM.resolveNode', { backendNodeId }, sessionId, commandOptions(state))
        .catch(() => ({ object: undefined }));
    const objectId = node.object?.objectId;
    if (!objectId) {
        throw new BrowserProgramError('STALE_ELEMENT_REF', 'The element of this ref was replaced or removed.', { recovery: 'Call page.observe() again and use the new ref, or use a role or text locator.' });
    }
    try {
        const response = pageResponse(await state.transport.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function (request) { return (${PROGRAM_PAGE_SOURCE}).call(this, request, ${options.selectMutation ?? 'undefined'}); }`,
            arguments: [{ value: request }],
            awaitPromise: true,
            returnByValue: true,
        }, sessionId, commandOptions(state)));
        return sessionId ? { ...response, frameSessionId: sessionId } : response;
    }
    finally {
        await state.transport
            .send('Runtime.releaseObject', { objectId }, sessionId, commandOptions(state))
            .catch(() => undefined);
    }
}
/** A frame realm's answer moved by its frame's origin: its point is now in the main viewport. */
function inMainViewport(response, origin) {
    if (!origin || typeof response.x !== 'number' || typeof response.y !== 'number')
        return response;
    const { frameLocal: _frameLocal, ...moved } = response;
    return { ...moved, x: response.x + origin.x, y: response.y + origin.y };
}
/**
 * Where a frame's viewport starts in the viewport of the session that holds
 * its owner element: the owner's content box, measured now. CDP answers boxes
 * of in-process frames in that session's root viewport.
 */
async function frameContentOrigin(state, frameId, sessionId) {
    const owner = await state.transport.send('DOM.getFrameOwner', { frameId }, sessionId, commandOptions(state));
    if (owner.backendNodeId === undefined)
        return undefined;
    const box = await state.transport.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, sessionId, commandOptions(state));
    const quad = box.model?.content;
    if (!quad || quad.length < 8)
        return undefined;
    return {
        x: Math.min(quad[0], quad[2], quad[4], quad[6]),
        y: Math.min(quad[1], quad[3], quad[5], quad[7]),
    };
}
/** Where an out-of-process frame sits in the main viewport, through its parent frames. */
async function attachedFrameOffset(state, frame, frames) {
    const parent = frame.parentSessionId
        ? frames.find((candidate) => candidate.sessionId === frame.parentSessionId)
        : undefined;
    const parentOffset = parent ? await attachedFrameOffset(state, parent, frames) : { x: 0, y: 0 };
    if (!parentOffset)
        return undefined;
    const origin = await frameContentOrigin(state, frame.frameId, frame.parentSessionId);
    return origin && { x: parentOffset.x + origin.x, y: parentOffset.y + origin.y };
}
function isEmptyResponse(response, request) {
    if (response.error === 'not_found')
        return true;
    if (request.kind === 'count')
        return response.count === 0;
    if (request.kind === 'readAll')
        return response.total === 0;
    return (request.kind === 'state' &&
        response.met !== true &&
        (request.state === 'visible' || request.state === 'attached'));
}
/**
 * Runs a request against a locator. The main frame (with its shadow DOM and
 * same-origin iframes) answers first; only when it has no match do the
 * out-of-process frames, in attach order, and the first with a match answers.
 */
export async function callAtLocator(state, locator, request, selectMutation) {
    const [first, ...rest] = locator.chain;
    if (first?.by === 'ref') {
        return callAtRef(state, first.ref, { ...request, chain: rest }, selectMutation);
    }
    const scoped = { ...request, chain: locator.chain };
    const options = selectMutation ? { selectMutation } : {};
    const main = await callProgramPage(state, scoped, options);
    if (!isEmptyResponse(main, request))
        return main;
    const frames = state.transport.listAttachedFrames?.() ?? [];
    for (const frame of frames) {
        const response = await callProgramPage(state, scoped, {
            ...options,
            sessionId: frame.sessionId,
        });
        if (isEmptyResponse(response, request))
            continue;
        // The frame that answered: a follow-up read of its focused element runs there.
        const located = { ...response, frameSessionId: frame.sessionId };
        if (typeof located.x !== 'number')
            return located;
        return framePointerChecked(state, scoped, async (attempt) => {
            const answer = attempt === scoped
                ? located
                : {
                    ...(await callProgramPage(state, attempt, {
                        ...options,
                        sessionId: frame.sessionId,
                    })),
                    frameSessionId: frame.sessionId,
                };
            if (typeof answer.x !== 'number')
                return { response: answer, framed: false };
            return {
                response: inMainViewport(answer, await attachedFrameOffset(state, frame, frames)),
                framed: true,
            };
        }, () => attachedFrameOwner(state, frame, frames));
    }
    return main;
}
/**
 * The one element a locator names now, as a backend node (in the same frame
 * order as callAtLocator). An action that changes what its own locator matches
 * (`input:not(:checked)` after a check) reads the result back from this node,
 * not from whatever the locator names afterwards. Undefined when the locator
 * names no single element.
 */
export async function pinLocatorNode(state, locator) {
    const [first, ...rest] = locator.chain;
    if (first?.by === 'ref') {
        const resolved = resolveBrowserSnapshotElement(state, first.ref);
        if (!resolved)
            return undefined;
        const { element } = resolved;
        const sessionId = element.commandSessionId;
        if (rest.length === 0) {
            return { backendNodeId: element.backendNodeId, ...(sessionId ? { sessionId } : {}) };
        }
        const node = await state.transport
            .send('DOM.resolveNode', { backendNodeId: element.backendNodeId }, sessionId, commandOptions(state))
            .catch(() => ({ object: undefined }));
        const objectId = node.object?.objectId;
        if (!objectId)
            return undefined;
        try {
            const handle = await state.transport.send('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: `function (request) { return (${PROGRAM_PAGE_SOURCE}).call(this, request); }`,
                arguments: [{ value: { kind: 'handle', chain: rest } }],
                returnByValue: false,
            }, sessionId, commandOptions(state));
            return await describeHandle(state, handle.result?.objectId, sessionId);
        }
        finally {
            await state.transport
                .send('Runtime.releaseObject', { objectId }, sessionId, commandOptions(state))
                .catch(() => undefined);
        }
    }
    const expression = programPageExpression({ kind: 'handle', chain: locator.chain });
    const sessions = [
        undefined,
        ...(state.transport.listAttachedFrames?.() ?? []).map((frame) => frame.sessionId),
    ];
    for (const sessionId of sessions) {
        const handle = await state.transport.send('Runtime.evaluate', { expression, returnByValue: false }, sessionId, commandOptions(state));
        const pinned = await describeHandle(state, handle.result?.objectId, sessionId);
        if (pinned)
            return pinned;
    }
    return undefined;
}
async function describeHandle(state, objectId, sessionId) {
    if (!objectId)
        return undefined;
    try {
        const described = await state.transport.send('DOM.describeNode', { objectId }, sessionId, commandOptions(state));
        const backendNodeId = described.node?.backendNodeId;
        return backendNodeId === undefined
            ? undefined
            : { backendNodeId, ...(sessionId ? { sessionId } : {}) };
    }
    finally {
        await state.transport
            .send('Runtime.releaseObject', { objectId }, sessionId, commandOptions(state))
            .catch(() => undefined);
    }
}
//# sourceMappingURL=locator-resolver.js.map