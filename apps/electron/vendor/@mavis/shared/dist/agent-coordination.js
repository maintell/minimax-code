/** Key used for the frozen value inside a Turn's `agent_profile` record. */
export const AGENT_PROFILE_COORDINATION_KEY = 'coordination';
const KNOWN_FIELDS = new Set([
    'role',
    'replyChannel',
    'helperAgents',
    'blockOperatorTools',
    'scheduleTarget',
    'reminders',
    'memoryPipeline',
    'contextProfile',
    'peerDelivery',
    'sessionVisibility',
    'homeDir',
]);
const KNOWN_REMINDERS = new Set(['assignment-snapshot']);
/**
 * Strict parser for bundled assets: an invalid block is a packaging defect and
 * must fail loudly instead of silently turning the coordinator into a plain Agent.
 */
export function parseAgentCoordinationConfig(value, source) {
    if (value === undefined)
        return undefined;
    const result = decode(value);
    if (typeof result === 'string') {
        throw new Error(`Invalid x-mavis.coordination in ${source}: ${result}`);
    }
    return result;
}
/**
 * Lenient reader for values already frozen into Turn state. Anything malformed
 * reads as absent, which is the ordinary-Agent behaviour.
 */
export function readAgentCoordinationConfig(value) {
    if (value === undefined)
        return undefined;
    const result = decode(value);
    return typeof result === 'string' ? undefined : result;
}
/**
 * Coordination frozen into a Turn's `agent_profile` record. Only an explicit
 * trusted built-in owner may carry it; every other profile reads as ordinary.
 */
export function readTrustedAgentProfileCoordination(agentProfile) {
    if (!agentProfile || typeof agentProfile !== 'object' || Array.isArray(agentProfile)) {
        return undefined;
    }
    const profile = agentProfile;
    if (profile.trusted_builtin !== true)
        return undefined;
    return readAgentCoordinationConfig(profile[AGENT_PROFILE_COORDINATION_KEY]);
}
export function isCoordinatorAgent(coordination) {
    return coordination?.role === 'coordinator';
}
/** The coordinator declared its own reminder set, so generic Turn reminders stay out. */
export function overridesGenericReminders(coordination) {
    return coordination?.reminders !== undefined;
}
export function schedulesTargetMainConversation(coordination) {
    return coordination?.scheduleTarget === 'main-conversation';
}
/** The Agent's root conversations compact their history in segments. */
export function usesSegmentContextProfile(coordination) {
    return coordination?.contextProfile === 'segment';
}
/** Messages other Sessions send the Agent's conversation always wait in its queue. */
export function queuesPeerDelivery(coordination) {
    return coordination?.peerDelivery === 'queue';
}
// Shared capability checks: what generic owners read instead of the Agent name.
/**
 * System reminder providers a coordinator with its own reminder set still receives: memory and
 * the one-shot wake and handoff reminders. Every other generic provider stays out.
 */
const COORDINATOR_SYSTEM_REMINDER_PROVIDERS = new Set([
    'pendingSessionReminders',
    'memorySkillReminder',
    'proactiveMemory',
    'memoryTopics',
    'cliSunsetMemoryNotice',
    'teamMemory',
    'relevantMemory',
    'userMemoryUpdate',
    'agentMemoryUpdate',
    'memorySummaryUpdate',
    'dailyMemoryUpdate',
]);
/** The system reminder providers a session of this Agent is limited to; absent means all. */
export function coordinatorSystemReminderAllowlist(coordination) {
    return overridesGenericReminders(coordination)
        ? COORDINATOR_SYSTEM_REMINDER_PROVIDERS
        : undefined;
}
/** True when this Agent's Root Sessions are created hidden from the session lists. */
export function hidesCoordinatorRootSessions(coordination) {
    return coordination?.sessionVisibility === 'hidden';
}
/** True when this Agent's home `<dataDir>/<Agent name>` is private: work there is no user Project. */
export function keepsPrivateHomeDir(coordination) {
    return coordination?.homeDir === 'private';
}
function decode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'must be a mapping';
    }
    const source = value;
    const unknownField = Object.keys(source).find((key) => !KNOWN_FIELDS.has(key));
    if (unknownField)
        return `unknown field ${unknownField}`;
    if (source.role !== 'coordinator')
        return 'role must be coordinator';
    const config = { role: 'coordinator' };
    if (source.replyChannel !== undefined) {
        if (source.replyChannel !== 'send_to_user')
            return 'replyChannel must be send_to_user';
        config.replyChannel = 'send_to_user';
    }
    if (source.helperAgents !== undefined) {
        const helpers = readNames(source.helperAgents);
        if (!helpers)
            return 'helperAgents must be a list of Agent names';
        config.helperAgents = helpers;
    }
    if (source.blockOperatorTools !== undefined) {
        if (typeof source.blockOperatorTools !== 'boolean') {
            return 'blockOperatorTools must be a boolean';
        }
        config.blockOperatorTools = source.blockOperatorTools;
    }
    if (source.scheduleTarget !== undefined) {
        if (source.scheduleTarget !== 'main-conversation') {
            return 'scheduleTarget must be main-conversation';
        }
        config.scheduleTarget = 'main-conversation';
    }
    if (source.reminders !== undefined) {
        const reminders = readNames(source.reminders);
        if (!reminders || reminders.some((name) => !KNOWN_REMINDERS.has(name))) {
            return 'reminders must list known reminder names';
        }
        config.reminders = reminders;
    }
    if (source.memoryPipeline !== undefined) {
        if (source.memoryPipeline !== 'bunny')
            return 'memoryPipeline must be bunny';
        config.memoryPipeline = 'bunny';
    }
    if (source.contextProfile !== undefined) {
        if (source.contextProfile !== 'segment')
            return 'contextProfile must be segment';
        config.contextProfile = 'segment';
    }
    if (source.peerDelivery !== undefined) {
        if (source.peerDelivery !== 'queue')
            return 'peerDelivery must be queue';
        config.peerDelivery = 'queue';
    }
    if (source.sessionVisibility !== undefined) {
        if (source.sessionVisibility !== 'hidden')
            return 'sessionVisibility must be hidden';
        config.sessionVisibility = 'hidden';
    }
    if (source.homeDir !== undefined) {
        if (source.homeDir !== 'private')
            return 'homeDir must be private';
        config.homeDir = 'private';
    }
    return Object.freeze(config);
}
function readNames(value) {
    if (!Array.isArray(value))
        return undefined;
    const names = value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''));
    return names.every(Boolean) ? [...new Set(names)] : undefined;
}
export function isBunnyReplyOrigin(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return (v.kind === 'bunny-reply' &&
        typeof v.messageId === 'string' &&
        typeof v.text === 'string' &&
        Array.isArray(v.files) &&
        v.files.every((f) => f &&
            typeof f.name === 'string' &&
            typeof f.mime === 'string' &&
            typeof f.path === 'string' &&
            (f.assetId === undefined || typeof f.assetId === 'string')));
}
//# sourceMappingURL=agent-coordination.js.map