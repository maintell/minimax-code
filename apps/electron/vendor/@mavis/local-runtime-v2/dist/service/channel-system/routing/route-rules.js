/**
 * Channel route rule store (`channel-routes.yaml`) and rule/target codecs.
 *
 * Migration copy (MR1) of the service half of v1 `channels/route-api.ts`.
 * Split performed here (proposal §4: route-api mixes Store/API/Response):
 * - the YAML store, rule matching, target normalization and the wire body
 *   readers (already-parsed `Record` in, structured result out) live here;
 * - the HTTP dispatcher (`routeLocalChannelRouteApi`) and its Request/
 *   Response handling stay with v1 until the MR3 delivery takeover.
 *
 * Validation used to build `Response` objects inline; the v2 copy returns a
 * structured {@link ChannelRouteApiError} carrying the exact legacy JSON body
 * fields (`error`, `errorCode`) plus HTTP status so MR3 can reproduce the
 * wire contract unchanged.
 */
import { join } from 'node:path';
import { channelRoutingModeForStrategy } from '@mavis/shared';
import { mutateDurableYaml, readYamlDocument } from '../binding/storage/durable-yaml.js';
const ROUTES_FILENAME = 'channel-routes.yaml';
const RULE_ID_REGEX = /^[a-z0-9-]+$/u;
const AGENT_ID_REGEX = /^[a-z0-9-]+$/u;
const VALID_PLATFORMS = ['feishu', 'telegram', 'wechat'];
const VALID_STRATEGIES = [
    'root',
    'main',
    'per-sender',
    'per-chat',
    'shared-task',
    'pin',
];
export class LocalChannelRouteStore {
    filePath;
    defaultAgentName;
    nowMs;
    config;
    constructor(filePath, defaultAgentName, nowMs, config) {
        this.filePath = filePath;
        this.defaultAgentName = defaultAgentName;
        this.nowMs = nowMs;
        this.config = config;
    }
    static async load(dataDir, defaultAgentName, nowMs) {
        const filePath = join(dataDir, ROUTES_FILENAME);
        let config = defaultConfig(defaultAgentName);
        const parsed = await readYamlDocument(filePath);
        if (Object.keys(parsed).length > 0)
            config = normalizeConfig(parsed, defaultAgentName, nowMs);
        const store = new LocalChannelRouteStore(filePath, defaultAgentName, nowMs, config);
        store.sortRules();
        return store;
    }
    getRules(platform) {
        const rules = platform
            ? this.config.rules.filter((rule) => rule.platform === platform)
            : this.config.rules;
        return [...rules];
    }
    getRule(ruleId) {
        return this.config.rules.find((rule) => rule.id === ruleId);
    }
    getDefaults() {
        return this.config.defaultRoute;
    }
    /**
     * Idempotently enrich the original route file before Phase-2 inbound opens.
     * `resolveOwner` may return undefined for a target whose Agent no longer
     * exists (deterministic dead reference): that target is kept as-is so
     * startup never bricks on it; inbound answers it with a receipt instead.
     */
    async migrateToV2(resolveOwner, resolveProjectKey) {
        await this.mutate(async (config) => {
            for (const platform of VALID_PLATFORMS) {
                const target = await migrateTarget(config.defaultRoute[platform], resolveOwner);
                if (!target)
                    continue;
                config.defaultRoute[platform] = {
                    ...target,
                    projectKey: resolveProjectKey?.({
                        exactOwnerName: target.exactOwnerName,
                        platform,
                        clientName: '*',
                        currentProjectKey: target.projectKey,
                    }) ?? target.projectKey,
                };
            }
            for (const rule of config.rules) {
                const target = await migrateTarget(rule.target, resolveOwner);
                if (!target)
                    continue;
                rule.target = {
                    ...target,
                    projectKey: resolveProjectKey?.({
                        exactOwnerName: target.exactOwnerName,
                        platform: rule.platform,
                        clientName: rule.match.clientName || '*',
                        currentProjectKey: target.projectKey,
                    }) ?? target.projectKey,
                };
            }
            assertSingleProjectPerRouteProfile(config);
            return { changed: true, value: undefined };
        });
    }
    async addRule(rule) {
        return this.mutate((config) => {
            if (config.rules.some((candidate) => candidate.id === rule.id)) {
                return {
                    changed: false,
                    value: {
                        error: {
                            status: 409,
                            error: `Route rule with id '${rule.id}' already exists`,
                            errorCode: 'RULE_ALREADY_EXISTS',
                        },
                    },
                };
            }
            config.rules.push(rule);
            return { changed: true, value: { rule } };
        });
    }
    async updateRule(ruleId, update) {
        return this.mutate((config) => {
            const index = config.rules.findIndex((rule) => rule.id === ruleId);
            if (index === -1) {
                return {
                    changed: false,
                    value: {
                        error: {
                            status: 404,
                            error: `Route rule '${ruleId}' not found`,
                            errorCode: 'RULE_NOT_FOUND',
                        },
                    },
                };
            }
            const existing = config.rules[index];
            const updated = {
                ...existing,
                ...update,
                id: existing.id,
                createdAt: existing.createdAt,
                updatedAt: this.nowMs(),
                match: update.match ? { ...existing.match, ...update.match } : existing.match,
                target: update.target
                    ? normalizeTarget({ ...existing.target, ...update.target })
                    : existing.target,
            };
            const validationError = validateRule(updated);
            if (validationError)
                return { changed: false, value: { error: validationError } };
            config.rules[index] = updated;
            return { changed: true, value: { rule: updated } };
        });
    }
    async deleteRule(ruleId) {
        return this.mutate((config) => {
            const index = config.rules.findIndex((rule) => rule.id === ruleId);
            if (index === -1)
                return { changed: false, value: false };
            config.rules.splice(index, 1);
            return { changed: true, value: true };
        });
    }
    async updateDefaults(body) {
        return this.mutate((config) => {
            const next = { ...config.defaultRoute };
            for (const platform of VALID_PLATFORMS) {
                const value = body[platform];
                if (value === undefined)
                    continue;
                if (!value || typeof value !== 'object') {
                    return {
                        changed: false,
                        value: {
                            error: {
                                status: 400,
                                error: `Invalid ${platform} default`,
                                errorCode: 'INVALID_DEFAULTS',
                            },
                        },
                    };
                }
                const target = normalizeDefaultTarget({ ...next[platform], ...value }, this.defaultAgentName);
                const validationError = validateDefaultTarget(platform, target);
                if (validationError)
                    return { changed: false, value: { error: validationError } };
                next[platform] = target;
            }
            config.defaultRoute = next;
            return { changed: true, value: { defaults: config.defaultRoute } };
        });
    }
    resolvePreview(ctx) {
        for (const rule of this.config.rules.filter((candidate) => candidate.platform === ctx.platform && candidate.enabled)) {
            const match = matchRule(rule, ctx);
            if (match === 'skip')
                continue;
            return {
                ruleId: rule.id,
                agentId: rule.target.agentId,
                sessionStrategy: rule.target.sessionStrategy,
                sessionTitle: match === 'block' ? '' : expandTemplate(rule.target.sessionTitle, ctx),
                blocked: match === 'block',
                exactOwnerName: rule.target.exactOwnerName,
                ...(rule.target.ownerInstanceId ? { ownerInstanceId: rule.target.ownerInstanceId } : {}),
                projectKey: rule.target.projectKey,
                routingMode: rule.target.routingMode,
                ...(rule.target.sessionId ? { sessionId: rule.target.sessionId } : {}),
                generation: rule.target.generation,
            };
        }
        const target = this.config.defaultRoute[ctx.platform];
        return {
            ruleId: null,
            agentId: target.agentId,
            sessionStrategy: target.sessionStrategy,
            sessionTitle: '',
            blocked: shouldBlockByMentionPolicy(ctx),
            exactOwnerName: target.exactOwnerName,
            ...(target.ownerInstanceId ? { ownerInstanceId: target.ownerInstanceId } : {}),
            projectKey: target.projectKey,
            routingMode: target.routingMode,
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
            generation: target.generation,
        };
    }
    /**
     * Rewrite the primary family's route state onto the canonical Agent (plan
     * §6.1): `rule.match.clientName`, `rule.target.agentId` and the per-platform
     * default target agentId. Routes owned by any other Agent are untouched.
     *
     * A rewritten rule that lands on a match key the canonical Agent already
     * owns is deduped when the two rules are otherwise identical, and reported as
     * a conflict when they differ — picking either one could silently change
     * which chats reach the surviving binding. `mode: 'inspect'` decides without
     * writing.
     */
    async rekeyPrimaryFamily(input) {
        return this.mutate((config) => {
            const plan = this.planRouteRekey(config, input);
            const result = plan.result;
            if (input.mode === 'inspect' || result.conflicts.length > 0) {
                return { changed: false, value: result };
            }
            const byId = new Map(plan.rewritten.map((rule) => [rule.id, rule]));
            config.rules = config.rules
                .filter((rule) => !plan.dropped.has(rule.id))
                .map((rule) => byId.get(rule.id) ?? rule);
            for (const platform of plan.defaultsToRewrite) {
                config.defaultRoute[platform] = {
                    ...config.defaultRoute[platform],
                    agentId: input.to.agentId,
                    exactOwnerName: input.to.agentId,
                };
            }
            return { changed: result.moved > 0 || result.deduped > 0, value: result };
        });
    }
    /** Decision phase of {@link rekeyPrimaryFamily}; mutates nothing. */
    planRouteRekey(config, input) {
        const conflicts = [];
        const rewritten = [];
        const dropped = new Set();
        const canonicalByMatch = new Map();
        for (const rule of config.rules) {
            if (rule.target.agentId === input.to.agentId)
                canonicalByMatch.set(routeMatchKey(rule), rule);
        }
        for (const rule of config.rules) {
            const ownsClient = rule.match.clientName === input.from.clientName;
            const ownsTarget = rule.target.agentId === input.from.agentId;
            if (!ownsClient && !ownsTarget)
                continue;
            const next = {
                ...rule,
                match: {
                    ...rule.match,
                    ...(ownsClient ? { clientName: input.to.clientName } : {}),
                },
                target: { ...rule.target, ...(ownsTarget ? { agentId: input.to.agentId } : {}) },
                updatedAt: this.nowMs(),
            };
            const collision = canonicalByMatch.get(routeMatchKey(next));
            if (!collision) {
                rewritten.push(next);
                continue;
            }
            if (routeRulesEquivalent(collision, next)) {
                dropped.add(rule.id);
                continue;
            }
            conflicts.push(`channel_route:${rule.id}`);
        }
        const defaultsToRewrite = VALID_PLATFORMS.filter((platform) => config.defaultRoute[platform].agentId === input.from.agentId);
        return {
            rewritten,
            dropped,
            defaultsToRewrite,
            result: {
                conflicts,
                moved: rewritten.length + defaultsToRewrite.length,
                deduped: dropped.size,
            },
        };
    }
    sortRules() {
        this.config.rules.sort((a, b) => a.priority - b.priority);
    }
    async mutate(operation) {
        return mutateDurableYaml(this.filePath, async (document) => {
            this.config = normalizeConfig(document, this.defaultAgentName, this.nowMs);
            this.sortRules();
            const result = await operation(this.config);
            if (result.changed) {
                this.config.schemaVersion = 2;
                this.sortRules();
                mergeConfigIntoDocument(document, this.config);
            }
            return result;
        });
    }
}
async function migrateTarget(target, resolveOwner) {
    const owner = await resolveOwner(target.agentId);
    if (!owner)
        return undefined;
    return {
        ...target,
        exactOwnerName: owner.exactOwnerName,
        ...(owner.ownerKind === 'custom' && owner.ownerInstanceId
            ? { ownerInstanceId: owner.ownerInstanceId }
            : { ownerInstanceId: undefined }),
        projectKey: target.projectKey || 'default',
        routingMode: target.routingMode ?? channelRoutingModeForStrategy(target.sessionStrategy),
        generation: Math.max(1, target.generation),
    };
}
function assertSingleProjectPerRouteProfile(config) {
    const projects = new Map();
    const visit = (key, projectKey) => {
        const existing = projects.get(key);
        if (existing !== undefined && existing !== projectKey) {
            throw Object.assign(new Error('One Channel route profile cannot target multiple Projects.'), {
                status: 409,
                code: 'CHANNEL_ROUTE_MULTI_PROJECT',
            });
        }
        projects.set(key, projectKey);
    };
    for (const platform of VALID_PLATFORMS) {
        const target = config.defaultRoute[platform];
        visit(`${target.exactOwnerName}|${platform}|*`, target.projectKey);
    }
    for (const rule of config.rules) {
        visit(`${rule.target.exactOwnerName}|${rule.platform}|${rule.match.clientName || '*'}`, rule.target.projectKey);
    }
}
function defaultConfig(defaultAgentName) {
    const target = defaultTarget(defaultAgentName);
    return {
        schemaVersion: 2,
        rules: [],
        defaultRoute: {
            feishu: { ...target },
            telegram: { ...target },
            wechat: { ...target },
        },
    };
}
function defaultTarget(defaultAgentName) {
    return {
        agentId: defaultAgentName,
        sessionStrategy: 'root',
        exactOwnerName: defaultAgentName,
        projectKey: 'default',
        routingMode: 'project-main',
        generation: 0,
    };
}
function normalizeConfig(value, defaultAgentName, nowMs) {
    if (!value || typeof value !== 'object')
        return defaultConfig(defaultAgentName);
    const raw = value;
    const base = defaultConfig(defaultAgentName);
    const rules = Array.isArray(raw.rules)
        ? raw.rules
            .map((rule) => normalizeRule(rule, nowMs()))
            .filter((rule) => rule !== undefined)
        : [];
    const defaults = raw.defaultRoute && typeof raw.defaultRoute === 'object'
        ? {
            ...base.defaultRoute,
            ...normalizeDefaults(raw.defaultRoute, defaultAgentName),
        }
        : base.defaultRoute;
    return {
        schemaVersion: readNumber(raw.schemaVersion) ?? 1,
        rules,
        defaultRoute: defaults,
    };
}
function normalizeDefaults(raw, defaultAgentName) {
    const defaults = {};
    for (const platform of VALID_PLATFORMS) {
        const value = raw[platform];
        if (value && typeof value === 'object') {
            defaults[platform] = normalizeDefaultTarget(value, defaultAgentName);
        }
    }
    return defaults;
}
function normalizeDefaultTarget(raw, defaultAgentName) {
    const agentId = readString(raw.agentId) ?? defaultAgentName;
    const sessionStrategy = normalizeStrategy(readString(raw.sessionStrategy)) ?? 'root';
    return {
        agentId,
        sessionStrategy,
        exactOwnerName: readString(raw.exactOwnerName) ?? agentId,
        ...(readString(raw.ownerInstanceId)
            ? { ownerInstanceId: readString(raw.ownerInstanceId) }
            : {}),
        projectKey: normalizeProjectKey(readString(raw.projectKey)),
        routingMode: normalizeRoutingMode(readString(raw.routingMode)) ??
            channelRoutingModeForStrategy(sessionStrategy),
        ...(readString(raw.sessionId) ? { sessionId: readString(raw.sessionId) } : {}),
        generation: normalizeGeneration(raw.generation),
    };
}
function normalizeTarget(raw) {
    const agentId = readString(raw.agentId)?.trim() ?? '';
    const sessionStrategy = normalizeStrategy(readString(raw.sessionStrategy)) ?? 'per-chat';
    const ownerInstanceId = readString(raw.ownerInstanceId)?.trim();
    const sessionId = readString(raw.sessionId)?.trim();
    return {
        agentId,
        sessionStrategy,
        sessionTitle: readString(raw.sessionTitle) ?? '',
        exactOwnerName: readString(raw.exactOwnerName)?.trim() || agentId,
        ...(ownerInstanceId ? { ownerInstanceId } : {}),
        projectKey: normalizeProjectKey(readString(raw.projectKey)),
        routingMode: normalizeRoutingMode(readString(raw.routingMode)) ??
            channelRoutingModeForStrategy(sessionStrategy),
        ...(sessionId ? { sessionId } : {}),
        generation: normalizeGeneration(raw.generation),
    };
}
function mergeConfigIntoDocument(document, config) {
    const oldRules = Array.isArray(document.rules) ? document.rules : [];
    const oldRulesById = new Map();
    for (const candidate of oldRules) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
            continue;
        const raw = candidate;
        const id = readString(raw.id);
        if (id)
            oldRulesById.set(id, raw);
    }
    document.schemaVersion = 2;
    document.rules = config.rules.map((rule) => {
        const previous = oldRulesById.get(rule.id) ?? {};
        const previousMatch = asRecord(previous.match);
        const previousTarget = asRecord(previous.target);
        return {
            ...previous,
            ...rule,
            match: { ...previousMatch, ...rule.match },
            target: { ...previousTarget, ...rule.target },
        };
    });
    const previousDefaults = asRecord(document.defaultRoute);
    const defaultRoute = { ...previousDefaults };
    for (const platform of VALID_PLATFORMS) {
        defaultRoute[platform] = {
            ...asRecord(previousDefaults[platform]),
            ...config.defaultRoute[platform],
        };
    }
    document.defaultRoute = defaultRoute;
}
function routeMatchKey(rule) {
    return [
        rule.platform,
        rule.match.chatType,
        rule.match.chatId,
        rule.match.senderId,
        rule.match.clientName,
    ].join('|');
}
/** Identical rekey outcome — dropping the legacy copy cannot change routing. */
function routeRulesEquivalent(collision, next) {
    return (collision.target.agentId === next.target.agentId &&
        collision.target.sessionStrategy === next.target.sessionStrategy &&
        collision.target.sessionTitle === next.target.sessionTitle &&
        collision.enabled === next.enabled &&
        collision.priority === next.priority &&
        (collision.requireMention ?? false) === (next.requireMention ?? false));
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function normalizeRule(value, nowMs) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    const head = readRuleHead(raw);
    if (!head)
        return undefined;
    const rule = {
        ...assembleRule(raw, head),
        createdAt: readTimestamp(raw.createdAt, nowMs),
        updatedAt: readTimestamp(raw.updatedAt, nowMs),
    };
    return validateRule(rule) ? undefined : rule;
}
/** Required identity of a rule row: id, platform, target agent. */
function readRuleHead(raw) {
    const id = readString(raw.id);
    const platform = normalizePlatform(readString(raw.platform));
    const rawTarget = raw.target && typeof raw.target === 'object' ? raw.target : {};
    const agentId = readString(rawTarget.agentId);
    if (!id || !platform || !agentId)
        return undefined;
    return { id, platform, rawTarget, agentId };
}
/** Shared body assembly used by both the YAML codec and the create reader. */
function assembleRule(raw, head) {
    return {
        id: head.id,
        platform: head.platform,
        match: normalizeMatch(raw.match),
        target: normalizeTarget({
            agentId: head.agentId,
            sessionStrategy: normalizeStrategy(readString(head.rawTarget.sessionStrategy)) ?? 'per-chat',
            sessionTitle: readString(head.rawTarget.sessionTitle) ?? '',
            ...head.rawTarget,
        }),
        enabled: readRuleEnabled(raw),
        priority: clampPriority(readNumber(raw.priority) ?? 50),
        ...(typeof raw.requireMention === 'boolean' ? { requireMention: raw.requireMention } : {}),
    };
}
/** Codec default (absent → enabled) shared with the create reader's `!== false`. */
function readRuleEnabled(raw) {
    return typeof raw.enabled === 'boolean' ? raw.enabled : true;
}
export function readCreateRule(body, nowMs) {
    const head = readRuleHead(body);
    const hasExplicitTarget = Boolean(body.target && typeof body.target === 'object');
    if (!head || !hasExplicitTarget) {
        return {
            error: {
                status: 400,
                error: 'Missing required fields: id, platform, target',
                errorCode: 'MISSING_FIELDS',
            },
        };
    }
    const rule = {
        ...assembleRule(body, head),
        // Create semantics differ from the codec default only in that an explicit
        // `enabled: false` is honoured; both treat absence as enabled.
        enabled: body.enabled !== false,
        createdAt: nowMs,
        updatedAt: nowMs,
    };
    const validationError = validateRule(rule);
    if (validationError)
        return { error: validationError };
    return { rule };
}
export function readRuleUpdate(body) {
    const update = {};
    const platform = normalizePlatform(readString(body.platform));
    if (platform)
        update.platform = platform;
    if (body.match && typeof body.match === 'object')
        update.match = readMatchUpdate(body.match);
    if (body.target && typeof body.target === 'object') {
        update.target = readTargetUpdate(body.target);
    }
    if (typeof body.enabled === 'boolean')
        update.enabled = body.enabled;
    if (typeof body.requireMention === 'boolean')
        update.requireMention = body.requireMention;
    const priority = readNumber(body.priority);
    if (priority !== undefined)
        update.priority = clampPriority(priority);
    return update;
}
/** Partial target update: only explicitly present, valid fields are applied. */
function readTargetUpdate(rawTarget) {
    const target = {};
    const agentId = readString(rawTarget.agentId);
    const sessionStrategy = normalizeStrategy(readString(rawTarget.sessionStrategy));
    const sessionTitle = readString(rawTarget.sessionTitle);
    if (agentId)
        target.agentId = agentId;
    if (sessionStrategy)
        target.sessionStrategy = sessionStrategy;
    if (sessionTitle !== undefined)
        target.sessionTitle = sessionTitle;
    const exactOwnerName = readString(rawTarget.exactOwnerName);
    const ownerInstanceId = readString(rawTarget.ownerInstanceId);
    const projectKey = readString(rawTarget.projectKey);
    const routingMode = normalizeRoutingMode(readString(rawTarget.routingMode));
    const sessionId = readString(rawTarget.sessionId);
    const generation = readNumber(rawTarget.generation);
    if (exactOwnerName)
        target.exactOwnerName = exactOwnerName;
    if (ownerInstanceId)
        target.ownerInstanceId = ownerInstanceId;
    if (projectKey)
        target.projectKey = normalizeProjectKey(projectKey);
    if (routingMode)
        target.routingMode = routingMode;
    if (sessionId)
        target.sessionId = sessionId;
    if (generation !== undefined)
        target.generation = Math.max(0, Math.trunc(generation));
    return target;
}
function readMatchUpdate(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const match = {};
    if (typeof raw.chatType === 'string')
        match.chatType = raw.chatType;
    if (typeof raw.chatId === 'string')
        match.chatId = raw.chatId;
    if (typeof raw.senderId === 'string')
        match.senderId = raw.senderId;
    if (typeof raw.clientName === 'string')
        match.clientName = raw.clientName;
    return match;
}
function normalizeMatch(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
        chatType: readString(raw.chatType) ?? '*',
        chatId: readString(raw.chatId) ?? '',
        senderId: readString(raw.senderId) ?? '',
        clientName: readString(raw.clientName) ?? '',
    };
}
export function readPreviewContext(body) {
    const platform = normalizePlatform(readString(body.platform));
    const chatType = readString(body.chatType);
    if (!platform || !chatType) {
        return {
            error: {
                status: 400,
                error: 'Missing required fields: platform, chatType',
                errorCode: 'MISSING_FIELDS',
            },
        };
    }
    return {
        ctx: {
            platform,
            chatType,
            chatId: readString(body.chatId) ?? '',
            senderId: readString(body.senderId) ?? '',
            clientName: readString(body.clientName) ?? '',
            hasMention: body.hasMention === true,
        },
    };
}
function validateRule(rule) {
    if (!isValidRuleId(rule.id)) {
        return {
            status: 400,
            error: `Invalid rule id: "${rule.id}". Must be kebab-case`,
            errorCode: 'INVALID_RULE_ID',
        };
    }
    if (!isChannelPlatform(rule.platform)) {
        return {
            status: 400,
            error: `Invalid platform: "${rule.platform}"`,
            errorCode: 'INVALID_PLATFORM',
        };
    }
    const defaultError = validateDefaultTarget(rule.platform, rule.target);
    if (defaultError)
        return defaultError;
    return undefined;
}
function validateDefaultTarget(platform, target) {
    if (!AGENT_ID_REGEX.test(target.agentId)) {
        return {
            status: 400,
            error: `Invalid ${platform} agentId`,
            errorCode: 'INVALID_AGENT_ID',
        };
    }
    if (!isSessionStrategy(target.sessionStrategy)) {
        return {
            status: 400,
            error: `Invalid ${platform} sessionStrategy`,
            errorCode: 'INVALID_STRATEGY',
        };
    }
    if ('projectKey' in target &&
        normalizeProjectKey(String(target.projectKey)) !== target.projectKey) {
        return {
            status: 400,
            error: `Invalid ${platform} projectKey`,
            errorCode: 'INVALID_PROJECT_KEY',
        };
    }
    return undefined;
}
function matchRule(rule, ctx) {
    if (rule.match.clientName && rule.match.clientName !== ctx.clientName)
        return 'skip';
    if (rule.match.chatType !== '*' && rule.match.chatType !== ctx.chatType)
        return 'skip';
    if (rule.match.chatId && rule.match.chatId !== ctx.chatId)
        return 'skip';
    if (rule.match.senderId && rule.match.senderId !== ctx.senderId)
        return 'skip';
    return shouldBlockByMentionPolicy(ctx, rule.requireMention) ? 'block' : 'match';
}
function shouldBlockByMentionPolicy(ctx, requireMention) {
    const effective = requireMention ?? defaultRequireMention(ctx);
    return effective && !ctx.hasMention;
}
function defaultRequireMention(ctx) {
    if (!['group', 'supergroup', 'channel'].includes(ctx.chatType))
        return false;
    return true;
}
function expandTemplate(template, ctx) {
    if (!template)
        return `${ctx.platform}-shared-${ctx.chatId}`;
    return template
        .replace(/\{platform\}/g, ctx.platform)
        .replace(/\{chatId\}/g, ctx.chatId)
        .replace(/\{senderId\}/g, ctx.senderId);
}
function readTimestamp(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
function clampPriority(value) {
    if (!Number.isFinite(value))
        return 50;
    return Math.max(0, Math.min(9999, Math.trunc(value)));
}
function readString(value) {
    return typeof value === 'string' ? value : undefined;
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function normalizePlatform(value) {
    return isChannelPlatform(value) ? value : undefined;
}
function normalizeStrategy(value) {
    return isSessionStrategy(value) ? value : undefined;
}
function normalizeRoutingMode(value) {
    return value === 'project-main' ||
        value === 'per-sender' ||
        value === 'per-chat' ||
        value === 'shared-task'
        ? value
        : undefined;
}
function normalizeProjectKey(value) {
    const normalized = value?.trim();
    return normalized === 'default' || normalized?.startsWith('workspace:') ? normalized : 'default';
}
function normalizeGeneration(value) {
    const generation = readNumber(value);
    return generation === undefined ? 0 : Math.max(0, Math.trunc(generation));
}
export function isChannelPlatform(value) {
    return typeof value === 'string' && VALID_PLATFORMS.includes(value);
}
function isSessionStrategy(value) {
    return typeof value === 'string' && VALID_STRATEGIES.includes(value);
}
export function isValidRuleId(value) {
    return RULE_ID_REGEX.test(value);
}
//# sourceMappingURL=route-rules.js.map