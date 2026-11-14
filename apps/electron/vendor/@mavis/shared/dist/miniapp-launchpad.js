/** Sources and app-owned conversations are not new ideas. */
export function miniAppLinkedSessionIds(state) {
    return [
        ...new Set((state.creations ?? [])
            .flatMap((item) => [item.sourceSessionId, item.sessionId])
            .filter((id) => Boolean(id))),
    ];
}
export function miniAppCreationSummary(item) {
    const title = (item.requirements || item.sourceTitle || item.pluginId).slice(0, 160);
    return {
        id: item.id,
        pluginId: item.pluginId,
        title,
        status: item.status,
        createdAt: item.createdAt,
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        ...(item.sourceSessionId ? { sourceSessionId: item.sourceSessionId } : {}),
        ...(item.recommendationId ? { recommendationId: item.recommendationId } : {}),
    };
}
const LAUNCHPAD_ERROR_CODES = [
    'invalid_request',
    'unavailable',
    'failed',
    'busy',
    'source_empty',
    'source_too_large',
    'maintenance_archived',
    'maintenance_missing',
    'maintenance_unavailable',
    'building_limit',
    'unfinished_limit',
];
export function isLaunchpadErrorCode(value) {
    return LAUNCHPAD_ERROR_CODES.some((code) => code === value);
}
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const id = (v) => text(v, 128) && /^[a-zA-Z0-9_.:-]+$/.test(v);
const pluginId = (v) => text(v, 80) && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(v);
export function isLaunchpadCommand(value) {
    if (!record(value) || typeof value.action !== 'string')
        return false;
    const allowed = {
        list: ['action'],
        'creation-ideas': ['action', 'language'],
        'creation-start': [
            'action',
            'requestId',
            'requirements',
            'sourceSessionId',
            'workspaceDir',
            'recommendationId',
            'sourceSummary',
        ],
        'creation-stop': ['action', 'creationId'],
        'creation-remove': ['action', 'creationId'],
        'creation-maintenance': ['action', 'pluginId', 'recover'],
        'creation-get': ['action', 'creationId', 'sessionId'],
    };
    const keys = allowed[value.action];
    if (!keys || Object.keys(value).some((key) => !keys.includes(key)))
        return false;
    if (value.action === 'creation-ideas')
        return value.language === 'zh' || value.language === 'en';
    if (value.action === 'list')
        return Object.keys(value).length === 1;
    if (value.action === 'creation-start')
        return (id(value.requestId) &&
            (value.recommendationId === undefined || id(value.recommendationId)) &&
            typeof value.requirements === 'string' &&
            value.requirements.length <= 12000 &&
            (value.workspaceDir === undefined ||
                (text(value.workspaceDir, 4096) && !value.workspaceDir.includes('\0'))) &&
            (value.sourceSummary === undefined ||
                (id(value.sourceSessionId) && text(value.sourceSummary, 12000))) &&
            (value.sourceSessionId === undefined || id(value.sourceSessionId)) &&
            (value.requirements.trim().length > 0 || id(value.sourceSessionId)));
    if (value.action === 'creation-stop' || value.action === 'creation-remove')
        return id(value.creationId);
    if (value.action === 'creation-get')
        return ((id(value.creationId) && value.sessionId === undefined) ||
            (id(value.sessionId) && value.creationId === undefined));
    if (value.action === 'creation-maintenance')
        return pluginId(value.pluginId) && typeof value.recover === 'boolean';
    return false;
}
export function isLaunchpadResponse(value) {
    if (!record(value))
        return false;
    if (value.ok === false)
        return isLaunchpadErrorCode(value.code);
    if (value.ok !== true)
        return false;
    if (value.creation !== undefined && !isMiniAppCreation(value.creation))
        return false;
    if (value.ideas !== undefined &&
        (!Array.isArray(value.ideas) || value.ideas.length > 2 || !value.ideas.every(isMiniAppIdea)))
        return false;
    if (value.state === undefined)
        return true;
    if (!record(value.state))
        return false;
    const { creations } = value.state;
    return (Array.isArray(creations) && creations.length <= 100 && creations.every(isMiniAppCreationSummary));
}
function isMiniAppCreationSummary(value) {
    return (record(value) &&
        id(value.id) &&
        pluginId(value.pluginId) &&
        text(value.title, 160) &&
        ['building', 'waiting', 'ready', 'failed', 'interrupted'].includes(String(value.status)) &&
        typeof value.createdAt === 'number' &&
        Number.isFinite(value.createdAt) &&
        (value.sessionId === undefined || id(value.sessionId)) &&
        (value.sourceSessionId === undefined || id(value.sourceSessionId)) &&
        (value.recommendationId === undefined || id(value.recommendationId)));
}
function isMiniAppCreation(value) {
    return (record(value) &&
        id(value.id) &&
        pluginId(value.pluginId) &&
        typeof value.requirements === 'string' &&
        value.requirements.length <= 12000 &&
        ['building', 'waiting', 'ready', 'failed', 'interrupted'].includes(String(value.status)) &&
        typeof value.createdAt === 'number' &&
        Number.isFinite(value.createdAt) &&
        (value.workspaceDir === undefined ||
            (text(value.workspaceDir, 4096) && !value.workspaceDir.includes('\0'))) &&
        (value.sessionId === undefined || id(value.sessionId)) &&
        (value.sourceSessionId === undefined || id(value.sourceSessionId)) &&
        (value.recommendationId === undefined || id(value.recommendationId)) &&
        (value.sourceSummary === undefined || text(value.sourceSummary, 12000)) &&
        (value.sourceTitle === undefined || text(value.sourceTitle, 500)) &&
        (value.sourceCapturedAt === undefined ||
            (typeof value.sourceCapturedAt === 'number' && Number.isFinite(value.sourceCapturedAt))) &&
        (value.error === undefined || text(value.error, 300)));
}
export function isMiniAppIdea(value) {
    return (record(value) &&
        text(value.title, 60) &&
        text(value.subtitle, 100) &&
        text(value.requirements, 1200) &&
        id(value.sourceSessionId) &&
        text(value.sourceTitle, 500));
}
//# sourceMappingURL=miniapp-launchpad.js.map