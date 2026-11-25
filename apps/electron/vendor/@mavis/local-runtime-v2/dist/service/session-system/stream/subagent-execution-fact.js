const SUBAGENT_EXECUTION_STATUSES = [
    'started',
    'completed',
    'failed',
    'aborted',
    'interrupted',
];
const IDENTITY_FIELDS = ['parent_session_id', 'child_session_id', 'turn_id', 'agent_name'];
/**
 * The single validity rule shared by the writer's recovery markers and the bound
 * Turn stream filter: a frame the writer persists is never dropped by the stream.
 */
export function parseSubagentExecutionFact(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const fact = value;
    if (fact.eventType !== 'subagent.execution')
        return undefined;
    if (!SUBAGENT_EXECUTION_STATUSES.includes(fact.status))
        return undefined;
    if (!IDENTITY_FIELDS.every((key) => typeof fact[key] === 'string' && fact[key]))
        return undefined;
    if (fact.parent_session_id === fact.child_session_id)
        return undefined;
    return value;
}
//# sourceMappingURL=subagent-execution-fact.js.map