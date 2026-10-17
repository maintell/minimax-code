import { getDesktopMatrixEndpoint } from '@mavis/agent-tools/desktop';
import { SessionHandoffError } from '../errors.js';
const PREPARE_PATH = '/minimax-cloud/api/v1/session-dispatch/prepare';
const SOURCE_TOKEN_HEADER = 'X-Mavis-Session-Dispatch-Token';
const ARTIFACT_KIND = {
    imported_history: 1,
    handoff_context: 2,
    file_manifest: 3,
};
const ARTIFACT_KIND_BY_ID = new Map([
    [1, 'imported_history'],
    [2, 'handoff_context'],
    [3, 'file_manifest'],
]);
const DEFAULT_PREPARE_TIMEOUT_MS = 30_000;
export class SessionHandoffCloudClient {
    options;
    baseUrl;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.baseUrl = (options.baseUrl ?? getDesktopMatrixEndpoint().baseUrl).replace(/\/$/u, '');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }
    async prepare(input) {
        const response = asPrepareResponse(await this.requestPrepareJson({
            client_request_id: input.clientRequestId,
            handoff_operation_id: input.handoffOperationId,
            source_device_id: input.sourceDeviceId,
            local_session_id: input.localSessionId,
            checkpoint: {
                turn_count: input.checkpoint.turnCount,
                last_message_id: input.checkpoint.lastMessageId,
            },
            session_spec: {
                agent_name: input.sessionSpec.agentName,
                ...(input.sessionSpec.title ? { title: input.sessionSpec.title } : {}),
                ...(input.sessionSpec.model
                    ? {
                        model: {
                            provider_id: input.sessionSpec.model.providerId,
                            model_id: input.sessionSpec.model.modelId,
                            // 真值判断会吞掉显式取值 —— variant 的语义由 handoffCloudModel
                            // 决定,这里只负责如实转成线协议字段。
                            ...(input.sessionSpec.model.variant !== undefined
                                ? { variant: input.sessionSpec.model.variant }
                                : {}),
                        },
                    }
                    : {}),
            },
            artifacts: input.artifacts.map((artifact) => ({
                kind: ARTIFACT_KIND[artifact.kind],
                sha256: artifact.sha256,
                size_bytes: artifact.sizeBytes,
            })),
            workspace: {
                revision_id: input.workspace.revisionId,
                manifest: {
                    manifest_hash: input.workspace.manifest.manifestHash,
                    file_count: input.workspace.manifest.fileCount,
                    total_bytes: input.workspace.manifest.totalBytes,
                },
            },
        }));
        assertBaseResponse(response.base_resp, `POST ${PREPARE_PATH}`);
        const dispatchId = requiredString(response.dispatch?.dispatch_id, 'dispatch id');
        assertPrepareState(response.dispatch?.state);
        const sourceDeviceToken = requiredString(response.source_device_token, 'source token');
        const artifactUploads = readUploadTickets(response.upload_tickets);
        const workspaceTransfer = response.workspace_transfer
            ? readTransferTicket(response.workspace_transfer)
            : undefined;
        return {
            dispatchId,
            sourceDeviceToken,
            artifactUploads,
            ...(workspaceTransfer ? { workspaceTransfer } : {}),
        };
    }
    async preflight(sourceDeviceId, localSessionId, signal) {
        const query = new URLSearchParams({
            source_device_id: sourceDeviceId,
            local_session_id: localSessionId,
        });
        const path = `/minimax-cloud/api/v1/session-dispatch/preflight?${query}`;
        const wire = await this.requestGetJson(path, {}, signal);
        logPreflightResponse(localSessionId, wire, this.options.logger);
        const response = asPreflightResponse(wire);
        if (response.allowed === true && response.reason === 1)
            return 'allowed';
        const deniedReasons = {
            2: 'in-progress',
            3: 'already-handed-off',
            4: 'cleanup-pending',
        };
        const denial = typeof response.reason === 'number' ? deniedReasons[response.reason] : undefined;
        if (response.allowed === false && denial)
            return denial;
        throw cloudError('Cloud handoff eligibility response is unknown or inconsistent');
    }
    async get(dispatchId, sourceDeviceToken) {
        const path = `/minimax-cloud/api/v1/session-dispatch?dispatch_id=${encodeURIComponent(dispatchId)}`;
        const response = asPrepareResponse(await this.requestGetJson(path, { [SOURCE_TOKEN_HEADER]: sourceDeviceToken }));
        assertBaseResponse(response.base_resp, `GET ${path}`);
        const dispatch = response.dispatch;
        return {
            dispatchId: requiredString(dispatch?.dispatch_id, 'dispatch id'),
            state: readDispatchState(dispatch?.state),
            readyToCommit: dispatch?.ready_to_commit === true,
            ...(typeof dispatch?.cloud_session_id === 'string' && dispatch.cloud_session_id
                ? { cloudSessionId: dispatch.cloud_session_id }
                : {}),
        };
    }
    async uploadArtifact(ticket, body) {
        await this.withTimeout(async (signal) => {
            let response;
            try {
                response = await this.fetchImpl(ticket.url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...(ticket.headers ?? {}) },
                    body: Buffer.from(body),
                    redirect: 'error',
                    signal,
                });
            }
            catch {
                throw cloudError('Cloud handoff artifact connection was interrupted', true);
            }
            if (!response.ok) {
                throw cloudError(`artifact upload HTTP ${response.status}`, retryableHTTPStatus(response.status));
            }
        }, { timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS, message: 'Cloud handoff artifact upload timed out' });
    }
    async commit(dispatchId, sourceDeviceToken) {
        const response = await this.resolveDispatch(dispatchId, sourceDeviceToken, 1);
        return {
            cloudSessionId: requiredString(response.dispatch?.cloud_session_id, 'cloud session id'),
        };
    }
    async abort(dispatchId, sourceDeviceToken, reason) {
        await this.resolveDispatch(dispatchId, sourceDeviceToken, 2, reason);
    }
    async listResultChanges(input) {
        const path = `/minimax-cloud/api/v1/session/${encodeURIComponent(input.cloudSessionId)}/result/${encodeURIComponent(input.resultId)}/diffs`;
        const response = asResultDiffsResponse(await this.requestGetJson(path, {}));
        assertBaseResponse(response.base_resp, `GET ${path}`);
        if (!Array.isArray(response.diffs))
            throw cloudError('result diffs response invalid');
        return response.diffs.map((value) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                throw cloudError('result diff entry invalid');
            }
            const entry = value;
            const relativePath = requiredString(entry.file, 'result diff path');
            const kind = resultChangeKind(entry.status);
            return { relativePath, kind };
        });
    }
    async syncResult(input) {
        const path = `/minimax-cloud/api/v1/session/${encodeURIComponent(input.cloudSessionId)}/result/${encodeURIComponent(input.resultId)}/sync`;
        const response = asSyncResponse(await this.requestJson(path, { selected_paths: input.selectedPaths }, { [SOURCE_TOKEN_HEADER]: input.sourceDeviceToken }));
        assertBaseResponse(response.base_resp, `POST ${path}`);
        if (!response.transfer)
            throw cloudError('result sync returned no transfer ticket');
        return readTransferTicket(response.transfer);
    }
    resolveTransferEndpoint(endpointUrl) {
        const resolved = new URL(endpointUrl, `${this.baseUrl}/`);
        const base = new URL(this.baseUrl);
        if (resolved.origin !== base.origin)
            throw cloudError('transfer endpoint origin mismatch');
        return resolved.toString();
    }
    createTransferAuth() {
        const initialAuth = this.options.authContextGetter();
        const headers = this.authHeaders(initialAuth);
        const loginEpoch = initialAuth?.loginEpoch;
        if (!loginEpoch)
            return { headers };
        let rejectedToken = initialAuth?.accessToken?.trim();
        const currentToken = () => {
            const auth = this.options.authContextGetter();
            // Electron 轮换凭据时先发布不带身份的 pending，再发布完整投影。
            // 允许此过渡态请求原登录的恢复，但不能从 pending 采用凭据。
            if (auth?.authState === 'pending' && !auth.loginEpoch)
                return undefined;
            if (auth?.loginEpoch !== loginEpoch || auth.authState === 'logged_out') {
                throw cloudError('session transfer login changed');
            }
            if (auth.authState === 'pending')
                return undefined;
            return auth.accessToken?.trim();
        };
        return {
            headers,
            refreshHeaders: async () => {
                const token = currentToken();
                if (!token || token === rejectedToken) {
                    try {
                        await this.options.authContextInvalidator?.(rejectedToken, loginEpoch);
                    }
                    catch {
                        currentToken();
                        throw cloudError('transfer authentication refresh is temporarily unavailable', true);
                    }
                }
                const refreshedToken = currentToken();
                if (!refreshedToken || refreshedToken === rejectedToken) {
                    throw cloudError('transfer authentication could not be refreshed', true);
                }
                rejectedToken = refreshedToken;
                // 接力票据绑定原环境；只更新同一次登录的凭据，不跟随途中切换的 lane。
                return { ...headers, Authorization: `Bearer ${refreshedToken}` };
            },
        };
    }
    async resolveDispatch(dispatchId, sourceDeviceToken, decision, reason) {
        const path = `/minimax-cloud/api/v1/session-dispatch/${encodeURIComponent(dispatchId)}/resolve`;
        const response = asPrepareResponse(await this.requestJson(path, { decision, ...(reason ? { reason } : {}) }, { [SOURCE_TOKEN_HEADER]: sourceDeviceToken }));
        assertBaseResponse(response.base_resp, `POST ${path}`);
        return response;
    }
    requestPrepareJson(body) {
        return this.requestJson(PREPARE_PATH, body, {}, {
            timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
            message: 'Cloud handoff preparation timed out',
        });
    }
    async requestJson(pathname, body, additionalHeaders = {}, timeout = {
        timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
        message: 'Cloud handoff request timed out',
    }) {
        return this.withTimeout((signal) => this.postJson(pathname, body, additionalHeaders, signal), timeout);
    }
    async withTimeout(request, timeout, signal) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        let timer;
        let cancel = () => undefined;
        const cancelled = new Promise((_resolve, reject) => {
            cancel = () => {
                controller.abort(signal?.reason);
                reject(signal?.reason);
            };
        });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted)
            cancel();
        const expired = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(cloudError(timeout.message, true, { reason: 'timeout' }));
                controller.abort();
            }, Math.max(1, timeout.timeoutMs));
            timer.unref?.();
        });
        try {
            return await Promise.race([request(controller.signal), expired, cancelled]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
        }
    }
    async postJson(pathname, body, additionalHeaders, signal) {
        const response = await this.fetchAuthenticated(pathname, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...additionalHeaders,
            },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
            this.logControlResponse(pathname, response);
            throw cloudError(`POST ${pathname}: Matrix backend HTTP ${response.status}`, await retryableControlFailure(response), { reason: 'http_error', httpStatus: response.status });
        }
        const bodyResponse = await readControlResponse(response);
        this.logControlResponse(pathname, response, bodyResponse);
        return bodyResponse;
    }
    async requestGetJson(pathname, additionalHeaders, outerSignal) {
        return this.withTimeout(async (signal) => {
            const response = await this.fetchAuthenticated(pathname, {
                method: 'GET',
                headers: additionalHeaders,
                signal,
            });
            if (!response.ok) {
                this.logControlResponse(pathname, response);
                throw cloudError(`GET ${pathname}: Matrix backend HTTP ${response.status}`, await retryableControlFailure(response), { reason: 'http_error', httpStatus: response.status });
            }
            const bodyResponse = await readControlResponse(response);
            this.logControlResponse(pathname, response, bodyResponse);
            return bodyResponse;
        }, { timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS, message: 'Cloud handoff status timed out' }, outerSignal);
    }
    logControlResponse(pathname, response, body) {
        const record = body && typeof body === 'object' ? body : {};
        const base = record.base_resp && typeof record.base_resp === 'object'
            ? record.base_resp
            : {};
        const trace = response.headers.get('traceid') ?? response.headers.get('x-trace-id');
        try {
            this.options.logger?.info({
                route: pathname.split('?')[0],
                httpStatus: response.status,
                ...(typeof base.status_code === 'number' ? { businessCode: base.status_code } : {}),
                ...(trace && /^[a-zA-Z0-9-]{16,64}$/u.test(trace) ? { traceId: trace } : {}),
            }, '[handoff-cloud-response]');
        }
        catch {
            /* Observability never changes a control request outcome. */
        }
    }
    async fetchAuthenticated(pathname, init) {
        const auth = this.createTransferAuth();
        const request = async (authHeaders) => {
            const headers = new Headers(init.headers);
            for (const [key, value] of Object.entries(authHeaders))
                headers.set(key, value);
            try {
                return await this.fetchImpl(`${this.baseUrl}${pathname}`, {
                    ...init,
                    headers,
                    redirect: 'error',
                });
            }
            catch {
                throw cloudError('Cloud handoff connection was interrupted', true, { reason: 'network' });
            }
        };
        const response = await request(auth.headers);
        if (response.status !== 401 || !auth.refreshHeaders)
            return response;
        await response.body?.cancel();
        const refreshedHeaders = await auth.refreshHeaders();
        return request(refreshedHeaders);
    }
    authHeaders(auth) {
        const token = auth?.accessToken?.trim();
        if (!token)
            throw cloudError('managed login is required', false, { reason: 'authentication' });
        return {
            // shared OAuth 发放的是 bearer token,而网关的 handoff 鉴权只从
            // Authorization 解析它;旧的 `Token` 头承载的是 Matrix 网页登录态,
            // runtime 启用 shared OAuth 后已不再持有,继续用它必然 401。
            Authorization: `Bearer ${token}`,
            ...(this.options.routingHeadersGetter?.() ?? {}),
        };
    }
}
async function retryableControlFailure(response) {
    if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return false;
    }
    try {
        const body = await response.json();
        if (body && typeof body === 'object' && 'retryable' in body) {
            if (typeof body.retryable === 'boolean')
                return body.retryable;
        }
    }
    catch {
        // A proxy error or interrupted error body may not contain an application hint.
    }
    return retryableHTTPStatus(response.status);
}
async function readControlResponse(response) {
    try {
        return await response.json();
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw cloudError('Cloud handoff response is not valid JSON');
        throw cloudError('Cloud handoff response was interrupted', true, { reason: 'network' });
    }
}
function logPreflightResponse(localSessionId, wire, logger) {
    if (!logger)
        return;
    const diagnostic = wire && typeof wire === 'object' ? wire : {};
    const base = diagnostic.base_resp;
    try {
        logger.info({
            localSessionId,
            allowed: typeof diagnostic.allowed === 'boolean' ? diagnostic.allowed : null,
            reason: typeof diagnostic.reason === 'number' ? diagnostic.reason : null,
            statusCode: typeof base?.status_code === 'number' ? base.status_code : null,
        }, '[handoff-preflight-response]');
    }
    catch {
        /* Diagnostic only. */
    }
}
function asPreflightResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw cloudError('Invalid preflight response');
    const response = value;
    // Eligibility must explicitly succeed before granting access.
    if (response.base_resp?.status_code !== 0)
        throw cloudError('Cloud handoff eligibility check failed');
    return response;
}
function asPrepareResponse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw cloudError('prepare response invalid');
    }
    return value;
}
function asSyncResponse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw cloudError('result sync response invalid');
    }
    return value;
}
function asResultDiffsResponse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw cloudError('result diffs response invalid');
    }
    return value;
}
function resultChangeKind(value) {
    switch (value) {
        case 'added':
            return 'add';
        case 'modified':
            return 'modify';
        case 'deleted':
            return 'delete';
        default:
            throw cloudError('result diff status invalid');
    }
}
function readUploadTickets(value) {
    if (!Array.isArray(value))
        throw cloudError('artifact upload tickets invalid');
    return value.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw cloudError('artifact upload ticket invalid');
        }
        const ticket = entry;
        const kind = ARTIFACT_KIND_BY_ID.get(requiredInteger(ticket.kind, 'artifact kind'));
        if (!kind)
            throw cloudError('artifact kind invalid');
        const headers = readStringMap(ticket.headers);
        return {
            kind,
            url: requiredString(ticket.upload_url, 'artifact upload URL'),
            ...(headers ? { headers } : {}),
        };
    });
}
function assertPrepareState(value) {
    if (value === undefined)
        return;
    const state = readDispatchState(value);
    if (state === 'expired') {
        throw new SessionHandoffError('HANDOFF_EXPIRED', 'Cloud handoff attempt has expired');
    }
    if (state === 'committed') {
        throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff is already committed; reconcile the existing Session');
    }
    if (state === 'aborted' || state === 'failed') {
        throw cloudError('Cloud handoff attempt has ended; create a new handoff proposal');
    }
}
function readDispatchState(value) {
    switch (requiredInteger(value, 'dispatch state')) {
        case 1:
            return 'prepared';
        case 2:
            return 'committed';
        case 3:
            return 'aborted';
        case 4:
            return 'failed';
        case 5:
            return 'expired';
        default:
            throw cloudError('dispatch state invalid');
    }
}
function readTransferTicket(value) {
    const ticket = {
        transferId: requiredString(value.transfer_id, 'transfer id'),
        endpointUrl: requiredString(value.endpoint_url, 'transfer endpoint'),
        accessToken: requiredString(value.access_token, 'transfer token'),
        expiresAt: requiredInteger(value.expires_at, 'transfer expiry'),
    };
    return {
        ...ticket,
        sourceRevisionId: requiredString(value.source_revision_id, 'transfer source revision'),
    };
}
function readStringMap(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw cloudError('ticket headers invalid');
    }
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string')
            throw cloudError('ticket header value invalid');
        result[key] = entry;
    }
    return result;
}
// `context` is "<METHOD> <pathname>" — identical business errors from different
// routes are indistinguishable without it (base_resp carries no request info).
function assertBaseResponse(value, context) {
    if (value === undefined || value === null)
        return;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw cloudError(`${context}: base response invalid`);
    }
    const response = value;
    const code = response.status_code ?? response.statusCode;
    if (code === undefined || code === 0)
        return;
    const message = typeof response.status_msg === 'string'
        ? response.status_msg
        : 'Matrix backend rejected request';
    throw cloudError(`${context}: cloud status ${String(code)}: ${message}`, false, {
        reason: 'business_rejected',
        ...(typeof code === 'number' ? { cloudStatusCode: code } : {}),
    });
}
function requiredString(value, name) {
    if (typeof value !== 'string' || value.length === 0)
        throw cloudError(`${name} missing`);
    return value;
}
function requiredInteger(value, name) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw cloudError(`${name} invalid`);
    }
    return value;
}
function cloudError(message, retryable = false, diagnostic = { reason: 'invalid_response' }) {
    return new SessionHandoffError('HANDOFF_UNAVAILABLE', message, retryable, diagnostic);
}
function retryableHTTPStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}
//# sourceMappingURL=cloud-client.js.map