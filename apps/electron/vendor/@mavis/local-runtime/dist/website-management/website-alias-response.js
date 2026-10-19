const WEBSITE_MANAGEMENT_CODES = [
    { code: 0, errorCode: 'OK', message: 'OK' },
    { code: 1, errorCode: 'NOT_FOUND', message: 'Website was not found.' },
    {
        code: 2,
        errorCode: 'WATERMARK_UNSUPPORTED',
        message: 'Website watermark updates are unsupported.',
    },
    { code: 3, errorCode: 'INVALID_ALIAS', message: 'Website alias is invalid.' },
    { code: 4, errorCode: 'ALIAS_CONFLICT', message: 'Website alias is already in use.' },
    { code: 5, errorCode: 'ALIAS_ALREADY_SET', message: 'Website alias is already set.' },
    { code: 6, errorCode: 'SAFETY_WITHDRAWN', message: 'Website was withdrawn for safety review.' },
    { code: 7, errorCode: 'UNPUBLISHED', message: 'Website is unpublished.' },
    { code: 8, errorCode: 'REPUBLISH_UNSUPPORTED', message: 'Website republish is unsupported.' },
    {
        code: 9,
        errorCode: 'TOKEN_PLAN_REQUIRED',
        message: 'A Token Plan is required for this website action.',
    },
    { code: 10, errorCode: 'CONTENT_REJECTED', message: 'Website content was rejected.' },
    {
        code: 11,
        errorCode: 'UPDATE_UNSUPPORTED',
        message: 'Website updates are unsupported.',
    },
    { code: 12, errorCode: 'UPDATE_IN_PROGRESS', message: 'Website update is in progress.' },
    {
        code: 13,
        errorCode: 'PROJECT_SOURCE_REQUIRED',
        message: 'Website project source is required.',
    },
    {
        code: 14,
        errorCode: 'PROJECT_SOURCE_NOT_RETAINED',
        message: 'Website project source is not retained.',
    },
    {
        code: 15,
        errorCode: 'ALIAS_BOUND_TO_SELF',
        message: 'Website alias is already bound to another site you own.',
    },
    {
        code: 16,
        errorCode: 'DOMAIN_REGISTRY_UNAVAILABLE',
        message: 'Website domain registry is unavailable.',
    },
    {
        code: 17,
        errorCode: 'ALIAS_UNBIND_UNSUPPORTED',
        message: 'Website alias unbind is unsupported.',
    },
    {
        code: 18,
        errorCode: 'INVALID_DISPLAY_NAME',
        message: 'Website display name is invalid.',
    },
    {
        code: 19,
        errorCode: 'ENTITLEMENT_LIMIT_EXCEEDED',
        message: "You've reached the website deployment limit for your current plan.",
    },
];
const WEBSITE_MANAGEMENT_CODE_BY_CODE = new Map(WEBSITE_MANAGEMENT_CODES.map((entry) => [entry.code, entry]));
const ALIAS_FAIL_CLOSED_CODE = 16;
const WEBSITE_ALIAS_BINDING_KEYS = new Set([
    'source',
    'binding_kind',
    'node_id',
    'display_name',
    'display_url',
    'screenshot_url',
    'deployment_status',
    'can_unbind',
]);
const WEBSITE_ALIAS_BINDING_REQUIRED_KEYS = [
    'source',
    'binding_kind',
    'display_name',
    'display_url',
    'deployment_status',
    'can_unbind',
];
export function sanitizeAliasCheckResponse(response, currentNodeId) {
    const aliasResponse = sanitizeAliasResponse(response);
    if (aliasResponse.code !== 0)
        return aliasResponse;
    switch (response.availability) {
        case 0:
        case 3:
            return { ...aliasResponse, availability: response.availability };
        case 1:
        case 2: {
            const binding = sanitizeWebsiteAliasBinding(response.binding, response.availability, currentNodeId);
            return binding
                ? { ...aliasResponse, availability: response.availability, binding }
                : canonicalAliasFailure(ALIAS_FAIL_CLOSED_CODE);
        }
        default:
            return canonicalAliasFailure(ALIAS_FAIL_CLOSED_CODE);
    }
}
function sanitizeWebsiteAliasBinding(value, availability, currentNodeId) {
    if (!isWebsiteAliasBindingSummary(value))
        return undefined;
    const binding = value;
    if (availability === 1 && (binding.source !== 1 || binding.node_id !== currentNodeId)) {
        return undefined;
    }
    if (availability === 2 && !Object.hasOwn(binding, 'node_id') && binding.source !== 2) {
        return undefined;
    }
    return {
        source: binding.source,
        binding_kind: binding.binding_kind,
        ...(Object.hasOwn(binding, 'node_id') ? { node_id: binding.node_id } : {}),
        display_name: binding.display_name,
        display_url: binding.display_url,
        ...(Object.hasOwn(binding, 'screenshot_url') ? { screenshot_url: binding.screenshot_url } : {}),
        deployment_status: binding.deployment_status,
        can_unbind: binding.can_unbind,
    };
}
function isWebsiteAliasBindingSummary(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const binding = value;
    if (Object.keys(binding).some((key) => !WEBSITE_ALIAS_BINDING_KEYS.has(key)))
        return false;
    if (WEBSITE_ALIAS_BINDING_REQUIRED_KEYS.some((key) => !Object.hasOwn(binding, key)))
        return false;
    return ((binding.source === 1 || binding.source === 2) &&
        (binding.binding_kind === 1 || binding.binding_kind === 2) &&
        isNonEmptyString(binding.display_name) &&
        isNonEmptyString(binding.display_url) &&
        (binding.deployment_status === 0 ||
            binding.deployment_status === 1 ||
            binding.deployment_status === 2 ||
            binding.deployment_status === 3 ||
            binding.deployment_status === 4) &&
        typeof binding.can_unbind === 'boolean' &&
        (!Object.hasOwn(binding, 'node_id') || isNonEmptyString(binding.node_id)) &&
        (!Object.hasOwn(binding, 'screenshot_url') || typeof binding.screenshot_url === 'string'));
}
export function sanitizeAliasResponse(response) {
    if (hasFailedBaseResp(response))
        return canonicalAliasFailure(ALIAS_FAIL_CLOSED_CODE);
    const code = readWebsiteManagementCode(response.code);
    if (code === undefined)
        return canonicalAliasFailure(ALIAS_FAIL_CLOSED_CODE);
    if (code !== 0)
        return canonicalAliasFailure(code);
    const baseResp = sanitizeSuccessfulAliasBaseResp(response);
    return { code: 0, ...(baseResp ? { base_resp: baseResp } : {}) };
}
function hasFailedBaseResp(response) {
    const baseResp = response.base_resp;
    if (baseResp === undefined)
        return false;
    if (typeof baseResp !== 'object' || Array.isArray(baseResp))
        return true;
    const statusCode = baseResp.status_code;
    return !Number.isInteger(statusCode) || statusCode !== 0;
}
function sanitizeSuccessfulAliasBaseResp(response) {
    const baseResp = response.base_resp;
    if (baseResp === undefined)
        return undefined;
    if (typeof baseResp !== 'object' || baseResp === null || Array.isArray(baseResp))
        return undefined;
    return baseResp.status_code === 0 ? { status_code: 0 } : undefined;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function readWebsiteManagementCode(value) {
    if (typeof value !== 'number' || !Number.isInteger(value))
        return undefined;
    return isWebsiteManagementCode(value) ? value : undefined;
}
function isWebsiteManagementCode(value) {
    return WEBSITE_MANAGEMENT_CODE_BY_CODE.has(value);
}
function canonicalAliasFailure(code) {
    const entry = WEBSITE_MANAGEMENT_CODE_BY_CODE.get(code);
    if (!entry || code === 0)
        return canonicalAliasFailure(ALIAS_FAIL_CLOSED_CODE);
    return {
        code: entry.code,
        error_code: entry.errorCode,
        message: entry.message,
    };
}
//# sourceMappingURL=website-alias-response.js.map