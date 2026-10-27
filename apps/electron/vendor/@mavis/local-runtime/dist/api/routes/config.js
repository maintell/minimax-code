import { getConfig, resolveBetaFeature } from '@mavis/config';
import { json, readFirstString, readJsonBody, sanitizeConfig, sanitizeProviderConfig, splitModelId, } from '../host-helpers.js';
import { buildPermissionModeOptionsResponse, isLocalPermissionModeString, normalizePermissionModeConfigBody, } from '../permission-mode-mapping.js';
import { listLocalRuntimeModels } from '../host-support.js';
import { isPeekEnabled } from '../../peek/gate.js';
/**
 * Entry point — handles every URL under `/config/**` plus the
 * `/external/llm-provider-discovery` GET. Returns `undefined` when the
 * (method, parts) tuple isn't a config-route, so the host's outer
 * dispatcher can keep walking the prefix table.
 */
export async function routeLocalConfigApi(deps, request, method, parts) {
    if (parts[0] === 'config') {
        if (method === 'GET' && parts.length === 1) {
            return handleLocalConfigGet(deps);
        }
        if (method === 'PUT' && parts.length === 1) {
            return handleLocalConfigPut(deps, request);
        }
        if (method === 'GET' && parts[1] === 'api-key-status') {
            return json(buildLocalApiKeyStatus({ configGetter: deps.configGetter }));
        }
        if (method === 'GET' && parts[1] === 'permission-mode-options') {
            return json({ options: buildPermissionModeOptionsResponse() });
        }
        if (method === 'POST' && parts[1] === 'api-key') {
            return routeLocalApiKeySave({
                body: await readJsonBody(request),
                configGetter: deps.configGetter,
                configUpdater: deps.configUpdater,
            });
        }
        return undefined;
    }
    if (parts.join('/') === 'external/llm-provider-discovery' && method === 'GET') {
        return json({ providers: sanitizeProviderConfig(deps.configGetter().provider ?? {}) });
    }
    return undefined;
}
/**
 * GET /config — returns the sanitized runtime config + beta overlay + the
 * resolved model list. The beta overlay mirrors `packages/daemon/src/api/config.ts`:
 * the runtime's resolved beta values win over the inline config so UI
 * surfaces gated on `=== true` don't receive an empty object. Thread Goal
 * also honors the live runtime config's explicit opt-out.
 */
function handleLocalConfigGet(deps) {
    const config = deps.configGetter();
    return json({
        ...sanitizeConfig(config),
        beta: resolvedLocalConfigBeta(config),
        models: listLocalRuntimeModels(deps.configGetter()),
    });
}
/**
 * PUT /config — applies the request body via configUpdater, then (when the
 * body may have switched the runtime to `acceptEdits`) runs the optional
 * permissionSeedRunner so the rule store catches up synchronously.
 *
 * Best-effort: seed-runner errors are swallowed because the next
 * `checkPermission` will surface any persistent store failure that
 * actually matters.
 */
async function handleLocalConfigPut(deps, request) {
    try {
        const body = normalizePermissionModeConfigBody(await readJsonBody(request));
        const previousConfig = deps.configGetter();
        const previousPermissionMode = previousConfig.permissionMode;
        const { config } = await deps.configUpdater(body);
        if (deps.permissionSeedRunner) {
            try {
                await deps.permissionSeedRunner(body);
            }
            catch {
                // Best-effort.
            }
        }
        const requestedPermissionMode = readRequestedPermissionMode(body);
        if (requestedPermissionMode &&
            requestedPermissionMode !== previousPermissionMode &&
            config.permissionMode === requestedPermissionMode) {
            deps.publishGlobalEvent?.({
                type: 'config.permission_mode.changed',
                payload: { permissionMode: requestedPermissionMode },
            });
        }
        return json({
            success: true,
            ...sanitizeConfig(config),
            beta: resolvedLocalConfigBeta(config),
            models: listLocalRuntimeModels(deps.configGetter()),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ success: false, error: message }, { status: 400 });
    }
}
function readRequestedPermissionMode(body) {
    const candidate = body.field === 'permissionMode' && Object.prototype.hasOwnProperty.call(body, 'set')
        ? body.set
        : body.permissionMode;
    return isLocalPermissionModeString(candidate) ? candidate : undefined;
}
function resolvedLocalConfigBeta(config) {
    const parsedBeta = getConfig().beta ?? {};
    return {
        ...parsedBeta,
        ...(config.beta ?? {}),
        threadGoal: resolveBetaFeature('threadGoal', config.beta?.threadGoal, {
            internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
        }),
        // peek is prodReady:false: force-off in prod regardless of any inline
        // `beta.peek: true` opt-in, while still honouring an explicit dev/test
        // opt-out (`beta.peek: false`).
        peek: isPeekEnabled(() => config),
    };
}
export function buildLocalApiKeyStatus(input) {
    const key = readApiKeyForProvider(input.configGetter, resolveApiKeyProviderId(input));
    return {
        valid: Boolean(key),
        currentKeyMasked: key ? maskApiKey(key) : '',
        isInternalBuild: false,
    };
}
export async function routeLocalApiKeySave(input) {
    const apiKey = readFirstString(input.body, ['apiKey', 'api_key']);
    if (!apiKey)
        return json({ success: false, error: 'apiKey is required' }, { status: 400 });
    const providerId = resolveApiKeyProviderId({
        configGetter: input.configGetter,
        preferredProviderId: readFirstString(input.body, ['providerId', 'provider_id']),
    });
    if (!providerId) {
        return json({ success: false, error: 'No provider is configured for saving apiKey.' }, { status: 400 });
    }
    try {
        await input.configUpdater({
            field: 'provider',
            put: {
                [providerId]: {
                    options: { apiKey },
                },
            },
        });
        return json({
            success: true,
            message: 'API key saved.',
            providerId,
            currentKeyMasked: maskApiKey(apiKey),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ success: false, error: message }, { status: 400 });
    }
}
function resolveApiKeyProviderId(input) {
    const provider = input.configGetter().provider ?? {};
    if (input.preferredProviderId && provider[input.preferredProviderId]) {
        return input.preferredProviderId;
    }
    const [defaultProviderId] = splitModelId(input.configGetter().defaultModel ?? '');
    if (defaultProviderId && provider[defaultProviderId])
        return defaultProviderId;
    return Object.keys(provider)[0];
}
function readApiKeyForProvider(configGetter, providerId) {
    if (!providerId)
        return undefined;
    const apiKey = configGetter().provider?.[providerId]?.options?.apiKey;
    return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
}
function maskApiKey(apiKey) {
    if (apiKey.length <= 8)
        return `${apiKey.slice(0, 2)}****`;
    return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}
//# sourceMappingURL=config.js.map