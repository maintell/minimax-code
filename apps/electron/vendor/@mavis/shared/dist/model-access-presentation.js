function localized(text, locale) {
    if (!text)
        return undefined;
    return locale?.toLowerCase().startsWith('zh') ? text.zhHans : text.en;
}
/** Master switch: false only on an explicit server answer; hides model access as a whole. */
export function modelAccessServiceEnabled(remote) {
    return remote?.serviceEnabled !== false;
}
export function modelAccessProviderHidden(remote, providerId, packageName) {
    return !!remote?.providerRules.some((rule) => rule.providerId === providerId &&
        (rule.packageName === undefined || rule.packageName === packageName));
}
/**
 * Same order as the runtime: entry rule, then source x capability, then the global rule.
 * `subscriptions` covers login and subscriptionBorrow. Without an entry only the capability
 * layers apply (a whole-capability or whole-source switch).
 */
export function modelAccessCapabilityHidden(remote, capability, sourceId, entry, packageName) {
    if (!remote)
        return false;
    const names = capability === 'apiKeyScan' ? [capability] : [capability, 'subscriptions'];
    const entryKey = entry ? `${capability}/${entry.entryId}/${entry.target}` : undefined;
    return remote.capabilityRules.some((rule) => {
        if (rule.packageName !== undefined && rule.packageName !== packageName)
            return false;
        if (rule.entryKey)
            return !!entryKey && rule.sourceId === sourceId && rule.entryKey === entryKey;
        if (!names.includes(rule.capability))
            return false;
        return rule.sourceId === undefined || rule.sourceId === sourceId;
    });
}
const USER_TRUST_SOURCES = new Set(['user-import', 'dev-session']);
/** Official catalog rules and presentation apply to official installations only. */
export function modelAccessOfficialInstallation(installation) {
    return !USER_TRUST_SOURCES.has(installation.trustSource ?? '');
}
function presentation(list, id) {
    return list?.find((item) => item.id === id);
}
/** Remote presentation first, then the built-in names, then the id. */
export function modelAccessRemoteProviderName(id, options = {}) {
    return (localized(presentation(options.remote?.providers, id)?.displayName, options.locale) ??
        modelAccessProviderName(id));
}
export function modelAccessRemoteSourceName(id, options = {}) {
    return (localized(presentation(options.remote?.sources, id)?.displayName, options.locale) ??
        modelAccessSourceName(id));
}
/** Verified local icon cache paths delivered remotely; absent means use built-in logos. */
export function modelAccessRemoteIcon(remote, kind, id) {
    const item = presentation(kind === 'provider' ? remote?.providers : remote?.sources, id);
    return item?.iconPath || item?.darkIconPath
        ? {
            ...(item.iconPath ? { iconPath: item.iconPath } : {}),
            ...(item.darkIconPath ? { darkIconPath: item.darkIconPath } : {}),
        }
        : undefined;
}
/** Stable sort by remote order; unordered items keep their position after ordered ones. */
function byRemoteOrder(items, order) {
    return items
        .map((item, index) => ({ item, index, order: order(item) }))
        .sort((a, b) => a.order !== undefined && b.order !== undefined
        ? a.order - b.order || a.index - b.index
        : a.order !== undefined
            ? -1
            : b.order !== undefined
                ? 1
                : a.index - b.index)
        .map((entry) => entry.item);
}
const SOURCE_NAMES = {
    claude: 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    copilot: 'GitHub Copilot',
    gemini: 'Gemini CLI',
    'gemini-cli': 'Gemini CLI',
    grok: 'Grok Build',
    zcode: 'ZCode',
    kiro: 'Kiro',
    workbuddy: 'WorkBuddy',
    'workbuddy-ai': 'WorkBuddy AI',
    'command-code': 'Command Code',
    devin: 'Devin CLI',
    qoder: 'Qoder',
    'qoder-cn': 'Qoder CN',
    factory: 'Factory',
    cline: 'Cline',
    zed: 'Zed',
    opendesign: 'OpenDesign',
    'trae-cn': 'Trae CN',
    'trae-global': 'Trae',
    antigravity: 'Antigravity',
    'mimo-app': 'MiMo',
    'mimo-code': 'MiMo Code',
    mimocode: 'MiMo Code',
    'cc-switch': 'CC Switch',
    alma: 'Alma',
};
const PROVIDER_NAMES = {
    ...SOURCE_NAMES,
    codex: 'ChatGPT',
    gemini: 'Gemini',
    grok: 'Grok',
    devin: 'Devin',
    'commandcode-plan': 'Command Code',
    'opencode-zen-free': 'OpenCode Zen Free',
};
export function modelAccessSourceName(id) {
    return SOURCE_NAMES[id] ?? id;
}
export function modelAccessProviderName(id) {
    return PROVIDER_NAMES[id] ?? id;
}
export function modelAccessMethodKey(method) {
    return [
        method.installationId,
        method.providerId,
        method.sourceId,
        method.capability,
        method.entryId,
        method.target,
    ].join('\0');
}
/** Preserve the existing host naming contract; ambiguity must never select an arbitrary provider. */
export function modelAccessSourceProvider(installation, source, target, credentialKind = 'direct-owned') {
    const providers = (installation.providers ?? []).filter((p) => p.credentialKinds.includes(credentialKind));
    const named = (id) => providers.find((p) => p.providerId === id)?.providerId;
    const prefixed = providers.filter((p) => p.providerId.startsWith(`${source.sourceId.replace(/-/gu, '')}-`));
    return (named(target) ??
        named(source.sourceId) ??
        (prefixed.length === 1 ? prefixed[0]?.providerId : undefined) ??
        (providers.length === 1 ? providers[0]?.providerId : undefined));
}
/**
 * API-only sources never become subscription vendors. Installations remain separate. Remote
 * rules hide providers and entry points; remote presentation names, orders and icons them.
 */
export function modelAccessVendors(installations, options = {}) {
    const { locale } = options;
    const vendors = installations.flatMap((installation) => {
        if (!installation.sources)
            return [];
        const official = modelAccessOfficialInstallation(installation);
        // User packages are not governed or renamed by the official catalog.
        const remote = official ? options.remote : undefined;
        const scoped = official ? options : { locale };
        const methods = [];
        for (const source of installation.sources) {
            for (const entry of source.entries) {
                if (entry.capability !== 'login' && entry.capability !== 'subscriptionBorrow')
                    continue;
                // WorkBuddy's `current` entry already reads protected fields; the legacy `protected`
                // variant stays declared for existing bindings but is no longer a separate choice.
                if (entry.capability === 'subscriptionBorrow' &&
                    source.sourceId === 'workbuddy' &&
                    entry.entryId === 'protected')
                    continue;
                const capability = entry.capability;
                const names = presentation(remote?.sources, source.sourceId)?.entries;
                for (const state of entry.targets) {
                    if (modelAccessCapabilityHidden(remote, capability, source.sourceId, { entryId: entry.entryId, target: state.target }, installation.name))
                        continue;
                    const providerId = modelAccessSourceProvider(installation, source, state.target, entry.capability === 'login' ? 'direct-owned' : 'borrowed-current');
                    if (!providerId)
                        continue;
                    const named = names?.find((item) => item.entryKey === `${capability}/${entry.entryId}/${state.target}`);
                    const label = localized(named?.displayName, locale);
                    methods.push({
                        installationId: installation.installationId,
                        providerId,
                        sourceId: source.sourceId,
                        hostAgentId: source.hostAgentId,
                        capability: entry.capability,
                        entryId: entry.entryId,
                        target: state.target,
                        ...(entry.kind ? { kind: entry.kind } : {}),
                        enabled: state.enabled,
                        ...(label ? { label } : {}),
                        ...(named?.order !== undefined ? { order: named.order } : {}),
                    });
                }
            }
        }
        return (installation.providers ?? []).flatMap((provider) => {
            if (modelAccessProviderHidden(remote, provider.providerId, installation.name))
                return [];
            const isPublic = provider.credentialKinds.length === 1 && provider.credentialKinds[0] === 'public';
            const seen = new Set();
            const own = byRemoteOrder(methods
                .filter((method) => {
                const key = modelAccessMethodKey(method);
                if (method.providerId !== provider.providerId || seen.has(key))
                    return false;
                seen.add(key);
                return true;
            })
                .sort((a, b) => Number(b.capability === 'subscriptionBorrow') -
                Number(a.capability === 'subscriptionBorrow')), (method) => method.order);
            const shown = presentation(remote?.providers, provider.providerId);
            const packaged = official
                ? undefined
                : installation.presentation?.find((entry) => entry.kind === 'provider' && entry.id === provider.providerId);
            const icon = official
                ? modelAccessRemoteIcon(remote, 'provider', provider.providerId)
                : packaged?.iconPath || packaged?.darkIconPath
                    ? {
                        ...(packaged.iconPath ? { iconPath: packaged.iconPath } : {}),
                        ...(packaged.darkIconPath ? { darkIconPath: packaged.darkIconPath } : {}),
                    }
                    : undefined;
            return isPublic || own.length
                ? [
                    {
                        key: `${installation.installationId}:${provider.providerId}`,
                        installationId: installation.installationId,
                        providerId: provider.providerId,
                        name: official
                            ? modelAccessRemoteProviderName(provider.providerId, scoped)
                            : (localized(packaged?.displayName, locale) ??
                                modelAccessProviderName(provider.providerId)),
                        ...(official ? {} : { userPackage: true }),
                        public: isPublic,
                        methods: own,
                        ...(shown?.order !== undefined ? { order: shown.order } : {}),
                        ...icon,
                    },
                ]
                : [];
        });
    });
    return byRemoteOrder(vendors, (vendor) => vendor.order);
}
/** A stable qualifier for sites and duplicate login methods, not an authorization decision. */
export function modelAccessMethodQualifier(method) {
    if (method.label)
        return method.label;
    if (method.providerId === 'zcode' && method.capability === 'login')
        return method.target === 'cn'
            ? 'BigModel'
            : method.target === 'global'
                ? 'Z.ai'
                : method.target;
    if (method.entryId === 'builder-id')
        return 'AWS Builder ID';
    if (method.entryId === 'social')
        return 'Google / GitHub';
    if (method.capability === 'subscriptionBorrow' && method.providerId === 'cursor')
        return method.entryId === 'desktop' ? 'Cursor Desktop' : 'Cursor CLI';
    if (method.capability === 'subscriptionBorrow' && method.sourceId === 'workbuddy')
        return modelAccessProviderName(method.providerId);
    return undefined;
}
export function groupModelAccessApiCandidates(candidates, failures = [], options = {}) {
    const groups = new Map();
    const group = (item) => {
        const key = `${item.installationId}:${item.sourceId}`;
        let value = groups.get(key);
        if (!value) {
            value = {
                key,
                sourceId: item.sourceId,
                name: modelAccessRemoteSourceName(item.sourceId, options),
                candidates: [],
                errors: [],
            };
            groups.set(key, value);
        }
        return value;
    };
    for (const candidate of candidates)
        group(candidate).candidates.push(candidate);
    for (const failure of failures) {
        const errors = group(failure).errors;
        if (!errors.includes(failure.errorCode))
            errors.push(failure.errorCode);
    }
    return [...groups.values()];
}
//# sourceMappingURL=model-access-presentation.js.map