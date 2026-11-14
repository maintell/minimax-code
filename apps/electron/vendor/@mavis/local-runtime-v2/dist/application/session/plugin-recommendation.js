import { defineRuntimeTool, } from '@mavis/agent-runtime';
import { getPluginPreparationReadiness, PLUGIN_PREPARATION_READY_OPTION_ID, PLUGIN_PREPARATION_STEP_ID, QUESTIONNAIRE_TTL_MS, } from '@mavis/shared/questionnaire';
import { createInternalTurnId } from '@mavis/shared/turn-identity';
import { InstalledPluginSource, PluginInstallationPolicy, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { pluginPreparationToolInput, readPluginPreparation, } from '../../service/questionnaire/index.js';
import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { createPluginMarketplaceSearch, } from './plugin-marketplace-search.js';
const SEARCH_TOOL = 'search_plugins';
const REQUEST_TOOL = 'request_plugin';
const MAX_CARDS_PER_TURN = 2;
/**
 * Desktop composition: Electron-owned runtimes get the recommendation
 * extension, and the single owned-action slot is shared with Plan by mode.
 */
export function composeDesktopPluginRecommendation(input) {
    if (!ownsElectronRuntimeCapabilities(input.runtimeOwnerKind)) {
        return { extensions: [], questionnaires: input.questionnaires };
    }
    const owner = createPluginRecommendation(input);
    return {
        extensions: [owner.extension],
        questionnaires: {
            ...input.questionnaires,
            bindOwnedAction: (handler, onFailure) => input.questionnaires.bindOwnedAction(composePluginQuestionnaireHandler(owner.handler, handler), onFailure),
        },
    };
}
const SearchSchema = Type.Object({
    query: Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'One service or brand name, or a concise capability phrase. Preserve a user-named target; search distinct needs separately. Search one query at a time and read the result before trying another term.',
    }),
    cursor: Type.Optional(Type.String({ maxLength: 16, description: 'next_cursor from the previous page.' })),
}, { additionalProperties: false });
const RequestSchema = Type.Object({
    plugin_name: Type.String({
        minLength: 1,
        maxLength: 160,
        description: 'Exact plugin_name returned by search_plugins.',
    }),
    reason: Type.String({
        minLength: 1,
        maxLength: 240,
        description: 'One concise task benefit shown to the user. Address the user naturally; do not mention tools, IDs, or the card.',
    }),
    required_apps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
        maxItems: 20,
        uniqueItems: true,
        description: 'Only the App providers this task needs. Omit when all are needed.',
    })),
    user_requested: Type.Optional(Type.Boolean({
        description: "Only for retrying a declined plugin when the user's latest message explicitly asks for it. Omit otherwise. Never overrides recommendable: false.",
    })),
}, { additionalProperties: false });
const ROUTING_PROMPT = [
    'Plugin discovery: when the user asks whether a service, app, or Mini App is available, wants to use a named capability, asks for plugin recommendations, or a task needs an integration the current tools cannot provide, check existing capabilities first and then call search_plugins with the service, brand, or capability name before saying it is unavailable, asking the user for credentials or tokens, or asking the user to run commands themselves.',
    'Merely mentioning a service, or discussing or explaining it, is not a reason to search or recommend.',
    'When a returned plugin is recommendable and not ready, call request_plugin directly: it adds an optional, non-blocking setup card to this reply, and the user decides on the card.',
    'Never ask about installing or connecting through ask_user. Offer at most two cards per reply, one per distinct need, and never re-offer a pending or declined plugin.',
    'The plugin-management Skill details these rules and is supplied with the first plugin tool result of each turn.',
].join(' ');
/** Same discovery routing when the user turned recommendations off: no card instructions. */
const SEARCH_ONLY_ROUTING_PROMPT = [
    'Plugin discovery: when the user asks whether a service, app, or Mini App is available, wants to use a named capability, or a task needs an integration the current tools cannot provide, check existing capabilities first and then call search_plugins with the service, brand, or capability name before saying it is unavailable, asking the user for credentials or tokens, or asking the user to run commands themselves.',
    'Merely mentioning a service, or discussing or explaining it, is not a reason to search.',
    'Plugin recommendation cards are turned off in the user settings: report what search_plugins finds and explain setup in words only. Never ask about installing or connecting through ask_user.',
    'The plugin-management Skill details discovery and is supplied with the first plugin tool result of each turn.',
].join(' ');
const CARDS_OFF_GUIDANCE_NOTE = 'Note: plugin recommendation cards are turned off in the user settings, so request_plugin is unavailable; apply the rules below to search and wording only.';
function createPluginRecommendation(input) {
    const nowMs = input.nowMs ?? Date.now;
    const searchMarketplace = createPluginMarketplaceSearch((request) => input.plugins.listMarketplacePlugins(request), nowMs);
    const conversationChecks = new WeakMap();
    const exposesDiscovery = (context) => {
        let check = conversationChecks.get(context);
        if (!check) {
            const profile = context.agentConfig.agent_profile;
            // A Mini App's own Agent session never shows cards and reads only the run result.
            check =
                profile?.surface === 'interactive' && !context.sessionOrigin?.miniApp
                    ? (async () => (await input.sessions.get(context.sessionId))?.sessionKind === 'conversation')()
                    : Promise.resolve(false);
            conversationChecks.set(context, check);
        }
        return check;
    };
    const recommendationEnabled = () => input.config().pluginRecommendation?.enabled !== false;
    const dismissedPlugins = () => new Set(input.config().pluginRecommendation?.dismissedPlugins ?? []);
    async function officialDetail(pluginName) {
        const response = await input.plugins.getMarketplacePlugin({
            pluginName,
            source: InstalledPluginSource.OFFICIAL,
        });
        if (!response.plugin || response.plugin.summary.name !== pluginName) {
            throw new Error(`Official plugin "${pluginName}" was not found. Use a plugin_name returned by search_plugins.`);
        }
        return response.plugin;
    }
    async function sessionStates(sessionId) {
        const records = await input.questionnaires.createService().listPluginPreparations(sessionId);
        return summarizePreparations(records, nowMs());
    }
    const search = createSearchTool({
        searchMarketplace,
        officialDetail,
        sessionStates,
        dismissedPlugins,
        recommendationEnabled,
    });
    const enabledAtTurnStart = new WeakMap();
    const requestDeps = {
        plugins: input.plugins,
        questionnaires: input.questionnaires,
        officialDetail,
        sessionStates,
        dismissedPlugins,
        recommendationEnabled,
        enabledAtTurnStart,
    };
    const createRequestTool = (assembly) => createRequestPluginTool(requestDeps, assembly);
    const attachedGuidance = new Set();
    const withGuidance = (tool, assembly) => ({
        ...tool,
        impl: {
            async execute(context, args, signal) {
                const result = await tool.impl.execute(context, args, signal);
                if (attachedGuidance.has(context.turnId))
                    return result;
                const guidance = await readGuidance(input, assembly);
                // Guidance is best-effort: the tool result (and any card it created) stands without it.
                if (!guidance)
                    return result;
                attachedGuidance.add(context.turnId);
                if (attachedGuidance.size > 256) {
                    attachedGuidance.delete(attachedGuidance.values().next().value);
                }
                return {
                    ...result,
                    content: [
                        ...result.content,
                        {
                            type: 'text',
                            text: `plugin-management Skill (loaded automatically for this capability; no separate skill call is needed):\n${recommendationEnabled() ? '' : `${CARDS_OFF_GUIDANCE_NOTE}\n\n`}${guidance}`,
                        },
                    ],
                    details: { ...result.details, auto_loaded_skill: 'plugin-management' },
                };
            },
        },
    });
    const extension = {
        id: 'plugin-recommendation',
        description: 'Desktop official plugin discovery and inline preparation cards.',
        init(api) {
            api.registerTool(async (context) => (await exposesDiscovery(context)) ? withGuidance(search, context) : null);
            api.registerTool(async (context) => {
                if (!(await exposesDiscovery(context)) || !recommendationEnabled())
                    return null;
                enabledAtTurnStart.set(context, (async () => {
                    try {
                        const response = await input.plugins.listEnabledPlugins({});
                        return new Set(response.plugins.map((plugin) => plugin.name));
                    }
                    catch {
                        return new Set();
                    }
                })());
                return withGuidance(createRequestTool(context), context);
            });
            api.contributeSystemPrompt(async (context) => {
                if (!(await exposesDiscovery(context)))
                    return null;
                return recommendationEnabled() ? ROUTING_PROMPT : SEARCH_ONLY_ROUTING_PROMPT;
            });
            api.registerReminderProvider({
                name: 'plugin-recommendation-state',
                compute: async (context) => {
                    if (!(await exposesDiscovery(context)))
                        return null;
                    const states = [...(await sessionStates(context.sessionId))].filter(([, entry]) => entry.state !== 'none');
                    if (states.length === 0)
                        return null;
                    const list = JSON.stringify(states.map(([name, entry]) => ({ name, status: entry.state })));
                    return {
                        content: `<system-reminder>\nPlugin suggestions in this conversation: ${list}. Pending cards already exist; do not repeat them. Declined means the user chose not now: do not recommend it again unless they explicitly change their mind. Ready plugins can be used. Respond to the latest message.\n</system-reminder>`,
                    };
                },
            });
        },
    };
    return { extension, handler: createPluginPreparationHandler(input, officialDetail) };
}
/** Owned-action owner for plugin-preparation rows: verify ready, continue, or stay silent. */
function createPluginPreparationHandler(input, officialDetail) {
    return {
        handles: (record) => readPluginPreparation(record) !== undefined,
        validateReply: async (record, reply) => {
            const preparation = readPluginPreparation(record);
            if (!preparation)
                throw new Error('Plugin preparation identity is missing.');
            if (!isReadyReply(reply))
                throw new Error('Plugin preparation accepts only a ready reply.');
            const detail = await officialDetail(preparation.pluginName);
            validateRequiredApps(detail, preparation.requiredApps);
            if (getPluginPreparationReadiness(detail, preparation.requiredApps) !== 'ready') {
                throw new Error('Plugin preparation is incomplete. Finish setup on the card and retry.');
            }
            const capabilities = await input.plugins.getPluginCapabilityReadiness(preparation.pluginName);
            if (capabilities.status === 'failed') {
                throw new Error(`Plugin capabilities failed to load (${capabilities.failedServers.join(', ')}). Retry from the card.`);
            }
            if (capabilities.status === 'loading') {
                throw new Error('Plugin capabilities are still loading. Retry shortly.');
            }
        },
        route: async ({ record, action }) => action.kind === 'dismiss'
            ? { kind: 'handled' }
            : {
                kind: 'continue-generic',
                continuationIdentity: createInternalTurnId('plugin-preparation', record.requestId),
            },
        afterConsumed: async ({ record, dispatch }) => {
            if (dispatch)
                await input.dispatchQueue(record.sessionId);
        },
    };
}
/**
 * request_plugin steps 2–5: recommendable, then a pending card is reused
 * (no further checks), then declined (unless user_requested), then the
 * per-reply card limit. Throws a model-readable reason on rejection.
 */
function assertRequestAdmissible(input) {
    if (!input.switchEnabled) {
        throw new Error("No card was shown: plugin recommendation cards were just turned off in the user settings. Do not retry. Report the plugin's actual readiness from search_plugins in plain words; if it is not ready, say it can be set up from the plugin marketplace.");
    }
    if (!isRecommendable(input.summary, input.dismissed, true)) {
        throw new Error(input.dismissed.has(input.summary.name)
            ? 'No card was shown: the user turned off recommendations for this plugin. user_requested cannot override it. Do not retry. Report its actual readiness from search_plugins in plain words; if it is not ready, say it can be set up from the plugin marketplace.'
            : 'No card was shown: this plugin cannot be offered as a card. user_requested cannot override it. Do not retry. Report its actual readiness from search_plugins in plain words; if it is not ready, say it can be set up from the plugin marketplace. Do not mention recommendation settings.');
    }
    if (input.current?.state === 'pending')
        return;
    if (input.current?.state === 'declined' && !input.userRequested) {
        throw new Error('The user declined this plugin in this conversation. Do not recommend it again unless their latest message explicitly asks for it; then retry with user_requested: true.');
    }
    if (input.turnCards >= MAX_CARDS_PER_TURN) {
        throw new Error('This reply already offers two plugin cards. Do not offer more; continue with the answer.');
    }
}
function createSearchTool(deps) {
    return defineRuntimeTool({
        name: SEARCH_TOOL,
        source: 'builtin',
        schema: SearchSchema,
        description: 'Search the official MCode plugin marketplace (including uninstalled plugins and Mini Apps) by name, brand, description, tags and example tasks. Read-only: returns real install/enable/App connection state, whether the plugin may be recommended, and its suggestion state in this conversation. Empty results do not prove absence.',
        execute: async (context, args, signal) => {
            if (!Value.Check(SearchSchema, args) || !args.query.trim()) {
                throw new Error('A non-empty search query is required.');
            }
            const query = args.query.trim();
            const page = await deps.searchMarketplace(query, args.cursor, signal);
            const states = await deps.sessionStates(context.sessionId);
            const dismissed = deps.dismissedPlugins();
            // A hit delisted after the catalog was cached is dropped, not fatal.
            const settled = await Promise.allSettled(page.plugins.map(async (summary) => {
                const detail = await deps.officialDetail(summary.name);
                return {
                    plugin_name: summary.name,
                    display_name: summary.displayName ?? summary.name,
                    ...(summary.description ? { description: summary.description } : {}),
                    installed: detail.summary.installExists,
                    enabled: detail.summary.enabled,
                    readiness: getPluginPreparationReadiness(detail),
                    apps: detail.apps.map((app) => ({
                        provider: app.provider,
                        ...(app.displayName ? { display_name: app.displayName } : {}),
                        status: app.status ?? 'unknown',
                    })),
                    recommendable: isRecommendable(detail.summary, dismissed, deps.recommendationEnabled()),
                    suggestion_state: states.get(summary.name)?.state ?? 'none',
                };
            }));
            const plugins = settled.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value] : []);
            const firstFailure = settled.find((entry) => entry.status === 'rejected');
            if (plugins.length === 0 && firstFailure)
                throw firstFailure.reason;
            signal?.throwIfAborted();
            return jsonResult(SEARCH_TOOL, {
                query,
                plugins,
                catalog_size: page.catalogSize,
                catalog_complete: page.catalogComplete && plugins.length === page.plugins.length,
                has_more: page.hasMore,
                ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
                next_action: plugins.length
                    ? 'Judge each description against the current need. Report availability and state when asked. For a recommendable plugin that is not ready and is needed now (including an availability question about it), call request_plugin; otherwise answer in words. Do not ask about installing through ask_user. For recommendable: false, do not call request_plugin and do not promote it unprompted; if it is what the user asked for, report its actual readiness in plain words, and if it is not ready, say it can be set up from the plugin marketplace. Never list installing or using a plugin as an ask_user option or access method, and never ask the user to paste tokens, passwords or credentials in chat; point to the plugin marketplace or settings instead. Marketplace entries are not files: never output plugin:// links or deliver-assets markup.'
                    : 'No catalog match for this query. Keep a user-named target; for capability wording, try a shorter or synonymous term. One empty result does not prove the capability is unavailable, and no card may be offered without a returned match. When reporting, say no matching official plugin was found; do not say it does not exist.',
            });
        },
    });
}
/** Routes plugin rows to the plugin owner and everything else to the existing owner (Plan). */
function composePluginQuestionnaireHandler(plugin, other) {
    const owner = (record) => (plugin.handles(record) ? plugin : other);
    return {
        handles: (record) => plugin.handles(record) || other.handles(record),
        validateReply: async (record, reply) => {
            await owner(record).validateReply?.(record, reply);
        },
        route: (routed) => owner(routed.record).route(routed),
        afterConsumed: async (consumed) => {
            await owner(consumed.record).afterConsumed?.(consumed);
        },
    };
}
/**
 * Latest suggestion state per plugin (oldest-first rows, so later rows win)
 * and the turn each card was created in. Expired pending cards and replaced
 * rows carry no state.
 */
function summarizePreparations(records, now) {
    const states = new Map();
    for (const record of records) {
        const preparation = readPluginPreparation(record);
        if (!preparation)
            continue;
        const entry = states.get(preparation.pluginName) ?? {
            state: 'none',
            requestId: record.requestId,
            turnIds: [],
        };
        const turnId = record.request.requester?.runId;
        if (turnId)
            entry.turnIds.push(turnId);
        const state = suggestionState(record, now);
        if (state !== 'none') {
            entry.state = state;
            entry.requestId = record.requestId;
        }
        states.set(preparation.pluginName, entry);
    }
    return states;
}
function suggestionState(record, now) {
    if (record.status === 'pending') {
        // Same deadline the card shows and the reply path enforces.
        return (record.request.expiresAt ?? record.createdAt + QUESTIONNAIRE_TTL_MS) > now
            ? 'pending'
            : 'none';
    }
    if (record.status === 'answered')
        return 'ready';
    if (record.status === 'dismissed')
        return 'declined';
    return 'none';
}
function countTurnCards(states, turnId) {
    let count = 0;
    for (const entry of states.values()) {
        count += entry.turnIds.filter((candidate) => candidate === turnId).length;
    }
    return count;
}
/** recommendation.enabled && not dismissed by the user && installable && available. */
function isRecommendable(summary, dismissed, switchEnabled) {
    const installable = summary.installationPolicy === undefined ||
        summary.installationPolicy === PluginInstallationPolicy.USER_MANAGED ||
        summary.installationPolicy === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE;
    return (switchEnabled &&
        summary.recommendation?.enabled === true &&
        !dismissed.has(summary.name) &&
        installable &&
        !summary.unavailableReason);
}
function validateRequiredApps(detail, requiredApps) {
    if (!requiredApps)
        return;
    if (requiredApps.length === 0) {
        throw new Error('Name the App providers the task needs, or omit required_apps.');
    }
    const unknown = requiredApps.filter((provider) => !detail.apps.some((app) => app.provider === provider));
    if (unknown.length > 0) {
        throw new Error(`App provider(s) ${unknown.join(', ')} do not belong to this plugin. Use providers returned by search_plugins.`);
    }
}
function isReadyReply(reply) {
    return reply.answers.some((answer) => answer.stepId === PLUGIN_PREPARATION_STEP_ID &&
        answer.selectedOptionIds.includes(PLUGIN_PREPARATION_READY_OPTION_ID));
}
function jsonResult(toolName, value) {
    const text = JSON.stringify(value);
    return { tool_name: toolName, text, content: [{ type: 'text', text }], details: {} };
}
function createRequestPluginTool(deps, assembly) {
    return defineRuntimeTool({
        name: REQUEST_TOOL,
        source: 'builtin',
        schema: RequestSchema,
        description: 'Offer one official plugin the current need justifies, as an optional inline setup card in this reply (Install / Enable / Connect and Not now). It installs or authorizes nothing and does not block the conversation. Call it directly; never ask about installation through ask_user. Do not repeat a pending card or re-offer a declined plugin.',
        execute: async (context, args, signal) => {
            if (!Value.Check(RequestSchema, args) || !args.reason.trim()) {
                throw new Error('Invalid plugin request: plugin_name and reason are required.');
            }
            const pluginName = args.plugin_name.trim();
            // 1. Official identity and App providers.
            const detail = await deps.officialDetail(pluginName);
            const requiredApps = args.required_apps?.map((provider) => provider.trim());
            validateRequiredApps(detail, requiredApps);
            // 2–5. Recommendable, pending reuse, declined, per-reply limit.
            const states = await deps.sessionStates(context.sessionId);
            const current = states.get(pluginName);
            assertRequestAdmissible({
                summary: detail.summary,
                dismissed: deps.dismissedPlugins(),
                current,
                userRequested: args.user_requested === true,
                turnCards: countTurnCards(states, context.turnId),
                switchEnabled: deps.recommendationEnabled(),
            });
            if (current?.state === 'pending') {
                return jsonResult(REQUEST_TOOL, {
                    status: 'pending',
                    already_pending: true,
                    request_id: current.requestId,
                    plugin_name: pluginName,
                    instruction: 'An earlier card for this plugin is still open in the reply where it was offered. Do not create another or remind the user to choose. If part of the task waits on this plugin, you may say so in one plain sentence. Do not tell the user what to click or name buttons, do not place the card in this reply, mention plugin_name/readiness/recommendable or IDs, or imply the plugin is already prepared or connected. Respond to the latest message.',
                });
            }
            // 6. Already usable: no card.
            if (getPluginPreparationReadiness(detail, requiredApps) === 'ready') {
                return readyPluginResult(deps, assembly, pluginName);
            }
            signal?.throwIfAborted();
            const preparation = {
                pluginName,
                reason: args.reason.trim(),
                ...(requiredApps ? { requiredApps } : {}),
            };
            const created = await deps.questionnaires.createService().beginOwned({
                sessionId: context.sessionId,
                runId: context.turnId,
                ...(context.assistantMessageId ? { messageId: context.assistantMessageId } : {}),
                ...(context.toolCallId ? { callId: context.toolCallId } : {}),
                mode: 'plugin-preparation',
                modePayload: { pluginPreparation: preparation },
                toolInput: pluginPreparationToolInput({
                    title: detail.summary.displayName ?? pluginName,
                    question: preparation.reason,
                }),
            });
            return {
                ...jsonResult(REQUEST_TOOL, {
                    status: 'pending',
                    request_id: created.requestId,
                    plugin_name: pluginName,
                    instruction: 'The card was added to this reply and renders below your reply text; it already explains the options. You may say that a card was offered in this reply, plus one plain sentence about what needs setup (for example "查询股东结构需要先安装并连接企查查。"). Do not place it elsewhere (such as an earlier reply or above), tell the user what to click or name buttons, mention plugin_name/readiness/recommendable or IDs, or imply the plugin is already prepared or connected. If the user named this service as the data source, do not start substitute research (web search, web fetch, or other tools) on your own: say in plain words what the plugin would provide, offer the public-source alternative in one sentence, and stop that part; continue only work that does not depend on that service. Otherwise continue independent work. Do not repeat this card later.',
                }),
                details: { request_id: created.requestId, waiting_for_user: false },
            };
        },
    });
}
/** Full plugin-management Skill text for the turn's Agent scope, read under its own gate. */
async function readGuidance(input, context) {
    try {
        const skill = await input.readNativeSkill({
            name: 'plugin-management',
            policy: { skills: [], features: { mavis: false, delegation: false, webSearch: false } },
            gates: { pluginRecommendationAvailable: true },
            scope: { ...skillResourceScope(context), workspaceDir: context.workspaceDir },
        });
        return skill?.content;
    }
    catch {
        return undefined;
    }
}
/**
 * The same Agent resource scope the `skill` tool reads with: the resolved
 * resource Agent (a deleted owner falls back to the default Agent) and the
 * profile's resolution flags.
 */
function skillResourceScope(context) {
    const config = context.agentConfig;
    const profile = (config.agent_profile ?? {});
    const resourceAgentName = config.resourceAgentName;
    const expectedAgentInstanceId = profile.expected_agent_instance_id;
    return {
        agentName: typeof resourceAgentName === 'string' && resourceAgentName
            ? resourceAgentName
            : context.agentName,
        ...(profile.exclude_agent_resources === true ? { excludeAgentResources: true } : {}),
        ...(profile.skip_agent_resolution === true ? { skipAgentResolution: true } : {}),
        ...(typeof expectedAgentInstanceId === 'string' && expectedAgentInstanceId
            ? { expectedAgentInstanceId }
            : {}),
    };
}
/** Step 6: an already prepared plugin needs no card; report whether this Turn can use it. */
async function readyPluginResult(deps, assembly, pluginName) {
    const capabilities = await deps.plugins.getPluginCapabilityReadiness(pluginName, {
        timeoutMs: 0,
    });
    if (capabilities.status === 'failed') {
        return jsonResult(REQUEST_TOOL, {
            status: 'capabilities_failed',
            plugin_name: pluginName,
            instruction: 'No card was needed: the plugin is installed, enabled and connected, but its capabilities failed to load. Say so in one plain sentence and that it can be retried from the plugin marketplace. Do not promise it will work on the next message, and do not mention a card, plugin_name/readiness/recommendable or IDs.',
        });
    }
    const enabledAtStart = await deps.enabledAtTurnStart.get(assembly);
    return jsonResult(REQUEST_TOOL, {
        status: 'ready',
        plugin_name: pluginName,
        usable_in_this_turn: capabilities.status === 'ready' && enabledAtStart?.has(pluginName) === true,
        instruction: 'No card was needed: the plugin is already installed, enabled and connected. Do not mention a card, plugin_name/readiness/recommendable or IDs. If usable_in_this_turn is false, say in one plain sentence that it becomes usable from the next message and end the reply so the user can continue.',
    });
}
//# sourceMappingURL=plugin-recommendation.js.map