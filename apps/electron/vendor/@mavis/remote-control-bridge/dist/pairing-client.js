export const RC_API_BASE_PATH = '/minimax-cloud/api/v1/remote-control';
export class PairingClientError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'PairingClientError';
    }
}
function parseBindingInfo(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new PairingClientError('bad_response', 'GET /binding: body is not an object');
    }
    // IDL RCBindingResp nests the info under `binding`; plan §3.1 documents the
    // flat RCBindingInfo shape. Accept both (nested preferred when present).
    const top = body;
    const candidate = top.binding && typeof top.binding === 'object' && !Array.isArray(top.binding)
        ? top.binding
        : top;
    const state = typeof candidate.state === 'string' ? candidate.state : 'none';
    const info = { state };
    if (typeof candidate.ticket === 'string')
        info.ticket = candidate.ticket;
    if (typeof candidate.endpoint === 'string')
        info.endpoint = candidate.endpoint;
    if (typeof candidate.bound_at_ms === 'number')
        info.bound_at_ms = candidate.bound_at_ms;
    if (typeof candidate.expires_at_ms === 'number')
        info.expires_at_ms = candidate.expires_at_ms;
    if (typeof candidate.binding_id === 'number')
        info.binding_id = candidate.binding_id;
    return info;
}
export class PairingClient {
    opts;
    fetchImpl;
    constructor(opts) {
        this.opts = opts;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    /** POST /pairing/code — issue a 4-digit pairing code (state=none flow). */
    async createPairingCode() {
        const body = { platform: this.opts.getPlatform() };
        const appVersion = this.opts.getAppVersion?.();
        if (appVersion)
            body.app_version = appVersion;
        const deviceName = await this.opts.getDeviceName?.();
        if (deviceName)
            body.device_name = deviceName;
        const wire = await this.call('POST', '/pairing/code', body);
        if (typeof wire.pairing_code !== 'string' || wire.pairing_code.length === 0) {
            throw new PairingClientError('bad_response', 'POST /pairing/code: missing pairing_code');
        }
        const expiresInS = typeof wire.expires_in_s === 'number' ? wire.expires_in_s : 300;
        return { pairing_code: wire.pairing_code, expires_in_s: expiresInS };
    }
    /**
     * GET /binding — binding state for this device (X-Device-Id locates it).
     * bound → biz signs a fresh one-shot 60s ticket on EVERY call; this is
     * also the reconnect re-ticket path (no separate ticket endpoint).
     */
    async getBinding() {
        const body = await this.call('GET', '/binding');
        return parseBindingInfo(body);
    }
    /** POST /unbind — delete the binding (user cancel / account switch). */
    async unbind(bindingId) {
        const wire = await this.call('POST', '/unbind', { binding_id: bindingId });
        return { ok: wire.ok !== false };
    }
    async call(method, path, body) {
        const jwt = this.opts.getJwt();
        this.opts.logger?.info(`[rc.pairing] ${method} ${path} jwt=${jwt ? `present(${jwt.length}chars)` : 'MISSING'}`);
        if (!jwt) {
            throw new PairingClientError('not_authenticated', 'no user JWT available');
        }
        const userId = this.opts.getUserId?.();
        const url = `${this.opts.baseUrl}${RC_API_BASE_PATH}${path}${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`;
        const headers = {
            // as-built biz auth: matrix extractToken reads the `token` header (it
            // never reads Authorization); Bearer kept for forward compat (ignored).
            token: jwt,
            Authorization: `Bearer ${jwt}`,
            'X-Device-Id': this.opts.getDeviceId(),
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            ...(this.opts.getExtraHeaders?.() ?? {}),
        };
        const init = { method, headers };
        if (method === 'POST')
            init.body = JSON.stringify(body ?? {});
        let res;
        try {
            res = await this.fetchImpl(url, init);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.opts.logger?.warn(`[rc.pairing] ${method} ${path} network error: ${msg}`);
            throw new PairingClientError('network', msg);
        }
        if (res.status === 401) {
            this.opts.logger?.warn(`[rc.pairing] ${method} ${path} → 401 token_expired`);
            throw new PairingClientError('token_expired', `401 from ${path}`, 401);
        }
        if (!res.ok) {
            const rawText = await res.text().catch(() => '');
            let code = `http_${res.status}`;
            let message = `HTTP ${res.status} from ${path}`;
            try {
                const parsed = JSON.parse(rawText);
                if (parsed.error?.code)
                    code = parsed.error.code;
                if (parsed.error?.message)
                    message = parsed.error.message;
                else if (typeof parsed.message === 'string')
                    message = parsed.message;
            }
            catch {
                // non-JSON error body — keep defaults
            }
            this.opts.logger?.warn(`[rc.pairing] ${method} ${path} → ${res.status} code=${code}`);
            throw new PairingClientError(code, message, res.status);
        }
        this.opts.logger?.debug(`[rc.pairing] ${method} ${path} → ${res.status}`);
        if (res.status === 204)
            return undefined;
        try {
            return (await res.json());
        }
        catch (err) {
            throw new PairingClientError('bad_response', `non-JSON body from ${path}: ${err instanceof Error ? err.message : String(err)}`, res.status);
        }
    }
}
//# sourceMappingURL=pairing-client.js.map