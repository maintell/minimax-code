/**
 * Client registration for interactive authorization (plan §5.5): pre-registered client →
 * CIMD (only with RFC 9207 + public-client support and a verified document) → DCR.
 * The callback listener is bound before registering so the redirect_uri carries the real port.
 * Registration results stay in attempt memory until the token commit.
 */
import { registerClient, } from '@mavis/mcp/oauth';
import { issuerHash, preRegisteredRedirect } from './canonical.js';
import { McpOAuthError } from './contracts.js';
const CIMD_CACHE_TTL_MS = 60 * 60_000;
const CIMD_REDIRECT_URI = 'http://127.0.0.1/oauth/mcp/callback';
const CIMD_CALLBACK_PATH = '/oauth/mcp/callback';
/** Verifies the hosted CIMD document once per hour; any failure means "use DCR". */
export class CimdAvailability {
    clientId;
    fetchFn;
    now;
    cached;
    inflight;
    constructor(clientId, fetchFn, now) {
        this.clientId = clientId;
        this.fetchFn = fetchFn;
        this.now = now;
    }
    async isAvailable() {
        if (this.cached && this.now() - this.cached.checkedAt < CIMD_CACHE_TTL_MS) {
            return this.cached.available;
        }
        this.inflight ??= this.checkOnce();
        return this.inflight;
    }
    async checkOnce() {
        try {
            return await this.check();
        }
        finally {
            this.inflight = undefined;
        }
    }
    async check() {
        let available = false;
        try {
            const response = await this.fetchFn(this.clientId, {
                headers: { Accept: 'application/json' },
            });
            if (response.ok) {
                const document = (await response.json());
                available =
                    document.client_id === this.clientId &&
                        Array.isArray(document.redirect_uris) &&
                        document.redirect_uris.includes(CIMD_REDIRECT_URI);
            }
            else {
                await response.body?.cancel();
            }
        }
        catch {
            available = false;
        }
        this.cached = { available, checkedAt: this.now() };
        return available;
    }
}
function dynamicRedirect(binding) {
    return {
        host: binding.oauth?.callbackHost ?? '127.0.0.1',
        port: binding.oauth?.callbackPort,
    };
}
function listenDynamic(input, redirect) {
    return input.callbackServer.listen({
        port: redirect.port ?? 0,
        dualStack: redirect.host !== '127.0.0.1',
    });
}
export async function prepareClient(input) {
    const clientId = input.binding.oauth?.clientId;
    if (clientId)
        return preRegisteredClient(input, clientId);
    const redirect = dynamicRedirect(input.binding);
    if (cimdEligible(input.discovery, redirect) && (await input.cimd.isAvailable())) {
        return cimdClient(input, redirect);
    }
    if (!input.discovery.metadata.registration_endpoint) {
        throw new McpOAuthError('MCP_OAUTH_REGISTRATION_FAILED');
    }
    const callbackPath = `${CIMD_CALLBACK_PATH}/${issuerHash(input.discovery.issuer)}`;
    return ((await reuseDcrClient(input, redirect, callbackPath)) ??
        registerDcrClient(input, redirect, callbackPath));
}
/**
 * The hosted document registers `http://127.0.0.1/oauth/mcp/callback`: any loopback port matches
 * it, but a `localhost` redirect does not, so an explicit `callbackHost: localhost` skips CIMD.
 */
function cimdEligible(discovery, redirect) {
    const { metadata } = discovery;
    return (redirect.host === '127.0.0.1' &&
        metadata.client_id_metadata_document_supported === true &&
        metadata.authorization_response_iss_parameter_supported === true &&
        (metadata.token_endpoint_auth_methods_supported ?? []).includes('none'));
}
/** Plan §5.5.1: redirect host/port/path by source format; a busy fixed port is an error. */
async function preRegisteredClient(input, clientId) {
    const redirect = preRegisteredRedirect(input.binding);
    if (typeof redirect === 'string')
        throw new McpOAuthError('MCP_OAUTH_UNSUPPORTED');
    const lease = await input.callbackServer.listen({
        port: redirect.port ?? 0,
        dualStack: redirect.host !== '127.0.0.1',
    });
    let redirectUri = `http://${redirect.host}:${lease.port}${redirect.path}`;
    if (redirect.template) {
        const url = new URL(redirect.template);
        if (!url.port)
            url.port = String(lease.port);
        redirectUri = url.href;
    }
    return {
        clientInformation: {
            client_id: clientId,
            ...(input.userClientSecret ? { client_secret: input.userClientSecret } : {}),
        },
        registration: {
            method: 'pre',
            client_id: clientId,
            redirect_uri: redirectUri,
            issuer: input.discovery.issuer,
        },
        redirectUri,
        callbackPath: redirect.path,
        lease,
    };
}
async function cimdClient(input, redirect) {
    const lease = await listenDynamic(input, redirect);
    const redirectUri = `http://${redirect.host}:${lease.port}${CIMD_CALLBACK_PATH}`;
    return {
        clientInformation: { client_id: input.cimd.clientId },
        registration: {
            method: 'cimd',
            client_id: input.cimd.clientId,
            token_endpoint_auth_method: 'none',
            redirect_uri: redirectUri,
            issuer: input.discovery.issuer,
        },
        redirectUri,
        callbackPath: CIMD_CALLBACK_PATH,
        lease,
    };
}
/**
 * Stored DCR client of the same issuer whose redirect still matches the configured host / port
 * and whose registered port is free. Anything else registers again (a configured busy port then
 * fails with `MCP_OAUTH_CALLBACK_PORT_IN_USE` before registering).
 */
async function reuseDcrClient(input, redirect, callbackPath) {
    const existing = input.existing;
    if (existing?.method !== 'dcr' || existing.issuer !== input.discovery.issuer)
        return undefined;
    const lease = await leaseRegisteredPort(input, existing.redirect_uri, redirect, callbackPath);
    if (!lease)
        return undefined;
    return {
        clientInformation: dcrClientInformation(existing),
        registration: existing,
        redirectUri: existing.redirect_uri,
        callbackPath,
        lease,
    };
}
async function registerDcrClient(input, redirect, callbackPath) {
    const lease = await listenDynamic(input, redirect);
    const redirectUri = `http://${redirect.host}:${lease.port}${callbackPath}`;
    // RFC 7591 / MCP: native loopback client; `application_type` is outside the SDK type.
    const clientMetadata = {
        client_name: 'MiniMax Code',
        application_type: 'native',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
    };
    try {
        const registered = await registerClient(input.discovery.issuer, {
            metadata: input.discovery.metadata,
            clientMetadata,
            ...(input.scope ? { scope: input.scope } : {}),
            fetchFn: input.fetchFn,
        });
        const registration = {
            method: 'dcr',
            client_id: registered.client_id,
            ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
            ...(registered.token_endpoint_auth_method
                ? { token_endpoint_auth_method: registered.token_endpoint_auth_method }
                : {}),
            redirect_uri: redirectUri,
            issuer: input.discovery.issuer,
        };
        return {
            clientInformation: dcrClientInformation(registration),
            registration,
            redirectUri,
            callbackPath,
            lease,
        };
    }
    catch (error) {
        lease.release();
        throw error instanceof McpOAuthError
            ? error
            : new McpOAuthError('MCP_OAUTH_REGISTRATION_FAILED', { cause: error });
    }
}
function dcrClientInformation(registration) {
    return {
        client_id: registration.client_id,
        ...(registration.client_secret ? { client_secret: registration.client_secret } : {}),
        ...(registration.token_endpoint_auth_method
            ? { token_endpoint_auth_method: registration.token_endpoint_auth_method }
            : {}),
    };
}
/** Re-binds the port of a stored DCR redirect; undefined when stale or taken (→ register again). */
async function leaseRegisteredPort(input, redirectUri, redirect, callbackPath) {
    let url;
    try {
        url = new URL(redirectUri);
    }
    catch {
        return undefined;
    }
    const registeredPort = Number(url.port);
    const stale = url.hostname !== redirect.host ||
        url.pathname !== callbackPath ||
        !url.port ||
        (redirect.port !== undefined && redirect.port !== registeredPort);
    if (stale)
        return undefined;
    try {
        return await listenDynamic(input, { host: redirect.host, port: registeredPort });
    }
    catch (error) {
        if (error instanceof McpOAuthError && error.code === 'MCP_OAUTH_CALLBACK_PORT_IN_USE') {
            return undefined;
        }
        throw error;
    }
}
//# sourceMappingURL=registration.js.map