/** Invalid `oauth` block; the message names fields only, never values. */
export class McpOAuthConfigError extends Error {
    name = 'McpOAuthConfigError';
}
const OAUTH_FIELD_PARSERS = {
    clientId: (value) => {
        if (typeof value !== 'string' || !value.trim()) {
            throw new McpOAuthConfigError('MCP oauth.clientId must be a non-empty string.');
        }
        return value.trim();
    },
    scopes: (value) => {
        if (!Array.isArray(value) ||
            value.some((scope) => typeof scope !== 'string' || !scope.trim() || /\s/u.test(scope))) {
            throw new McpOAuthConfigError('MCP oauth.scopes must be an array of scope tokens.');
        }
        return value;
    },
    callbackPort: (value) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65_535) {
            throw new McpOAuthConfigError('MCP oauth.callbackPort must be an integer from 1024 to 65535.');
        }
        return value;
    },
    callbackHost: (value) => {
        if (value !== 'localhost' && value !== '127.0.0.1') {
            throw new McpOAuthConfigError('MCP oauth.callbackHost must be localhost or 127.0.0.1.');
        }
        return value;
    },
    authServerMetadataUrl: parseHttpsUrl,
};
const PROJECT_OAUTH_FIELDS = ['callbackPort'];
/** Validates an `oauth` block; throws `McpOAuthConfigError` for the owning server only. */
export function parseMcpOAuthConfig(value, source) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new McpOAuthConfigError('MCP oauth must be an object.');
    }
    const entries = Object.entries(value);
    const allowed = source === 'user' ? Object.keys(OAUTH_FIELD_PARSERS) : PROJECT_OAUTH_FIELDS;
    const unsupported = entries.map(([key]) => key).filter((key) => !allowed.includes(key));
    if (unsupported.length > 0) {
        throw new McpOAuthConfigError(source === 'user'
            ? `Unsupported MCP oauth fields: ${unsupported.join(', ')}. Client secrets are stored through the settings secret field.`
            : `Project .mcp.json only supports oauth.callbackPort; remove: ${unsupported.join(', ')}.`);
    }
    const config = {};
    for (const [key, field] of entries) {
        if (field !== undefined) {
            config[key] = OAUTH_FIELD_PARSERS[key](field);
        }
    }
    return config;
}
function parseHttpsUrl(value) {
    let url;
    try {
        url = typeof value === 'string' ? new URL(value) : undefined;
    }
    catch {
        url = undefined;
    }
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
        throw new McpOAuthConfigError('MCP oauth.authServerMetadataUrl must be an HTTPS URL.');
    }
    return url.toString();
}
/** Static `Authorization` header (case-insensitive) owns credentials; OAuth stays off. */
export function hasAuthorizationHeader(headers) {
    return Object.keys(headers ?? {}).some((key) => key.trim().toLowerCase() === 'authorization');
}
/** `oauth` and a static `Authorization` header cannot be configured together. */
export function assertOAuthHeaderExclusive(oauth, headers) {
    if (oauth !== undefined && hasAuthorizationHeader(headers)) {
        throw new McpOAuthConfigError('MCP oauth cannot be combined with a static Authorization header.');
    }
}
//# sourceMappingURL=oauth-config.js.map