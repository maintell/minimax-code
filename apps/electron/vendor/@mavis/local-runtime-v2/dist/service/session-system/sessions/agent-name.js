export const PRIMARY_SESSION_AGENT_NAMES = ['mavis', 'main'];
export function isPrimarySessionAgentName(agentName) {
    return agentName === 'mavis' || agentName === 'main';
}
export function isSameSessionAgentName(left, right) {
    return left === right || (isPrimarySessionAgentName(left) && isPrimarySessionAgentName(right));
}
export function projectPrimarySessionAgentName(record, requestedAgentName) {
    if (!isPrimarySessionAgentName(requestedAgentName) ||
        !isPrimarySessionAgentName(record.agentName) ||
        record.agentName === requestedAgentName) {
        return record;
    }
    return { ...record, agentName: requestedAgentName };
}
//# sourceMappingURL=agent-name.js.map