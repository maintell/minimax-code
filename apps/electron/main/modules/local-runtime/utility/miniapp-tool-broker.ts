import { randomUUID } from "node:crypto";
import { readMiniAppToolPermissionDecision } from "@mavis/shared/miniapp-surface";
import { isSafeBrokerRequestId } from "./control";
/** Bounds a page request at Main: the Utility bounds its own prompt at five minutes. */
const PAGE_REQUEST_TIMEOUT_MS = 6 * 60000;
const MAX_TOOLS = 10;
const MAX_TEXT = 4096;
const PAGE_ERROR_CODES = {
    INVALID_ARGUMENTS: 'invalid_request',
    TOOL_NOT_PERMITTED: 'not_permitted',
    TOOL_UNAVAILABLE: 'runtime_unavailable',
};
/**
 * Utility side of the Mini App tool channel: asks Main to show the Host tool-permission prompt
 * (`requestApproval`, the presenter's `requestToolApproval`) and answers Main's page
 * `tool.request` with the bound application entry.
 */
export class UtilityMiniAppToolBroker {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closed = false;
        this.requestApproval = (input) => {
            if (this.closed || input.signal.aborted)
                return Promise.resolve('unavailable');
            const requestId = randomUUID();
            return new Promise((resolve) => {
                const onAbort = () => {
                    settle('unavailable');
                    this.post({ type: 'miniapp-tool-approval-cancel', requestId });
                };
                const settle = (answer) => {
                    if (!this.pending.delete(requestId))
                        return;
                    input.signal.removeEventListener('abort', onAbort);
                    resolve(answer);
                };
                this.pending.set(requestId, settle);
                input.signal.addEventListener('abort', onAbort, { once: true });
                const posted = this.post({
                    type: 'miniapp-tool-approval',
                    requestId,
                    request: { mode: input.mode, pluginId: input.pluginId, tools: input.tools },
                });
                if (!posted)
                    settle('unavailable');
            });
        };
    }
    bind(tools) {
        this.tools = tools;
    }
    handleMessage(value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-tool-approval-result') {
            if (!isSafeBrokerRequestId(value.requestId))
                return true;
            const answer = value.answer === 'unavailable'
                ? 'unavailable'
                : readMiniAppToolPermissionDecision(value.answer);
            // A malformed answer never allows: it counts as a refusal.
            this.pending.get(value.requestId)?.(answer ?? { decision: 'deny' });
            return true;
        }
        if (value.type !== 'miniapp-tool-request')
            return false;
        if (isSafeBrokerRequestId(value.requestId))
            void this.answerPageRequest(value);
        return true;
    }
    close() {
        this.closed = true;
        for (const settle of [...this.pending.values()])
            settle('unavailable');
    }
    async answerPageRequest(value) {
        const requestId = value.requestId;
        let response;
        const tools = this.tools;
        if (!tools) {
            response = { success: false, code: 'runtime_unavailable' };
        }
        else if (typeof value.pluginId !== 'string' || !Array.isArray(value.names)) {
            response = { success: false, code: 'invalid_request' };
        }
        else {
            response = await pageResponse(tools, value.pluginId, value.names);
        }
        this.post({ type: 'miniapp-tool-request-result', requestId, response });
    }
    post(message) {
        try {
            this.options.postMessage(message);
            return true;
        }
        catch {
            return false;
        }
    }
}

async function pageResponse(tools, pluginId, names) {
    try {
        const result = await tools.request({ pluginId, names });
        return result.approvalRequired
            ? { success: false, code: 'approval_required', permissions: result.permissions }
            : { success: true, permissions: result.permissions };
    }
    catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
        return { success: false, code: PAGE_ERROR_CODES[code] ?? 'result_unknown' };
    }
}
/** Main side of the Mini App tool channel, per Utility child. */
export class MainMiniAppToolBroker {
    constructor(options) {
        this.options = options;
        this.approvals = new Map();
        this.pageRequests = new Map();
    }
    handleMessage(target, value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-tool-approval-cancel') {
            if (isSafeBrokerRequestId(value.requestId)) {
                this.approvals.get(target)?.get(value.requestId)?.abort();
            }
            return true;
        }
        if (value.type === 'miniapp-tool-request-result') {
            if (isSafeBrokerRequestId(value.requestId)) {
                const response = readPageResponse(value.response);
                this.pageRequests.get(target)?.get(value.requestId)?.(response);
            }
            return true;
        }
        if (value.type !== 'miniapp-tool-approval')
            return false;
        if (!isSafeBrokerRequestId(value.requestId))
            return true;
        const request = readApprovalInput(value.request);
        if (!request) {
            postSafely(target, {
                type: 'miniapp-tool-approval-result',
                requestId: value.requestId,
                answer: 'unavailable',
            });
            return true;
        }
        void this.showApproval(target, value.requestId, request);
        return true;
    }
    /** The page's `tool.request`; Main resolved `pluginId` from the sending tab. */
    requestFromPage(target, input) {
        const requestId = randomUUID();
        const requests = this.pageRequests.get(target) ?? new Map();
        this.pageRequests.set(target, requests);
        return new Promise((resolve) => {
            const settle = (response) => {
                if (requests.get(requestId) !== settle)
                    return;
                requests.delete(requestId);
                clearTimeout(timer);
                resolve(response);
            };
            const timer = setTimeout(() => settle({ success: false, code: 'result_unknown' }), PAGE_REQUEST_TIMEOUT_MS);
            timer.unref?.();
            requests.set(requestId, settle);
            const posted = postSafely(target, {
                type: 'miniapp-tool-request',
                requestId,
                pluginId: input.pluginId,
                names: input.names,
            });
            if (!posted)
                settle({ success: false, code: 'runtime_unavailable' });
        });
    }
    releaseTarget(target) {
        for (const controller of this.approvals.get(target)?.values() ?? [])
            controller.abort();
        this.approvals.delete(target);
        for (const settle of [...(this.pageRequests.get(target)?.values() ?? [])]) {
            settle({ success: false, code: 'runtime_unavailable' });
        }
        this.pageRequests.delete(target);
    }
    async showApproval(target, requestId, request) {
        const controllers = this.approvals.get(target) ?? new Map();
        this.approvals.set(target, controllers);
        const controller = new AbortController();
        controllers.set(requestId, controller);
        let answer = 'unavailable';
        try {
            answer = this.options.requestApproval
                ? await this.options.requestApproval({ ...request, signal: controller.signal })
                : 'unavailable';
        }
        catch {
            answer = 'unavailable';
        }
        finally {
            controllers.delete(requestId);
        }
        if (controller.signal.aborted)
            return;
        postSafely(target, { type: 'miniapp-tool-approval-result', requestId, answer });
    }
}

function readApprovalInput(value) {
    if (!isRecord(value) || (value.mode !== 'call' && value.mode !== 'request'))
        return null;
    if (!isBoundedText(value.pluginId) || !Array.isArray(value.tools))
        return null;
    if (value.tools.length === 0 || value.tools.length > MAX_TOOLS)
        return null;
    const tools = value.tools.map(readToolItem);
    if (tools.some((tool) => tool === null))
        return null;
    return {
        mode: value.mode,
        pluginId: value.pluginId,
        tools: tools,
    };
}
function readToolItem(value) {
    if (!isRecord(value) || (value.kind !== 'mcp' && value.kind !== 'connector'))
        return null;
    if (!isBoundedText(value.name) || !isBoundedText(value.owner) || !isBoundedText(value.tool)) {
        return null;
    }
    const preview = value.argumentsPreview;
    if (preview !== undefined && !isBoundedText(preview))
        return null;
    return {
        name: value.name,
        kind: value.kind,
        owner: value.owner,
        tool: value.tool,
        ...(typeof preview === 'string' ? { argumentsPreview: preview } : {}),
    };
}
function readPageResponse(value) {
    if (!isRecord(value))
        return { success: false, code: 'result_unknown' };
    const permissions = readPermissions(value.permissions);
    if (value.success === true && permissions)
        return { success: true, permissions };
    const code = Object.values(PAGE_ERROR_CODES).find((item) => item === value.code);
    if (value.success === false && value.code === 'approval_required' && permissions) {
        return { success: false, code: 'approval_required', permissions };
    }
    if (value.success === false && (code || value.code === 'result_unknown')) {
        return { success: false, code: code ?? 'result_unknown' };
    }
    return { success: false, code: 'result_unknown' };
}
function readPermissions(value) {
    if (!isRecord(value))
        return null;
    const entries = Object.entries(value);
    if (entries.length > MAX_TOOLS)
        return null;
    const permissions = {};
    for (const [name, verdict] of entries) {
        if (verdict !== 'allow' && verdict !== 'ask' && verdict !== 'deny')
            return null;
        permissions[name] = verdict;
    }
    return permissions;
}
function postSafely(target, message) {
    try {
        target.postMessage(message);
        return true;
    }
    catch {
        // Utility exited between request settlement and delivery.
        return false;
    }
}
function isBoundedText(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
