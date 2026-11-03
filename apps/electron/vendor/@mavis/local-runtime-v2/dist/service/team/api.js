import { LocalTeamPlanStore } from './plan-records.js';
/**
 * Active AgentTeam ownership is persisted in the existing plan files. Both
 * the plan's control session and its live worker sessions are automation-owned
 * while the plan is running.
 */
export async function hasActiveLocalTeamOwner(dataDir, sessionId) {
    const records = await new LocalTeamPlanStore(dataDir).list();
    return records.some((record) => record.state.status === 'running' &&
        (record.state.owner_session_id === sessionId ||
            Object.prototype.hasOwnProperty.call(record.state.engine_sessions, sessionId)));
}
//# sourceMappingURL=api.js.map