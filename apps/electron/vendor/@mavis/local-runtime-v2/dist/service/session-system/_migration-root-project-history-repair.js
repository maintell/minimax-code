import { and, eq } from 'drizzle-orm';
import { sessionAgentDefinitions, sessions } from '../../infra/db/schema/sessions.js';
import { isPrimarySessionAgentName } from './sessions/agent-name.js';
import { decodeSessionAgentDefinition, isCurrentSessionAgentDefinition, serializeSessionAgentDefinition, } from './sessions/repo/agent-binding.js';
import { CURRENT_SESSION_COLUMNAR_VERSION, decodeSessionRow, encodeSessionRow, } from './sessions/repo/drizzle/codec.js';
import { normalizeAbsolutePath, pathFlavor } from './shared/path-normalization.js';
import { canonicalProjectWorkspaceDir, isAgentInternalDefaultWorkspaceDir, isSessionDefaultWorkspaceDir, } from './shared/workspace.js';
/**
 * Correct one narrowly proven legacy error: an Agent root whose configured
 * Project directory was written with the default-Project bit. This deliberately
 * has no durable marker: later starts re-check the remaining, still-default rows.
 */
export async function repairRootProjectHistory(input) {
    const summary = createSummary();
    let rows;
    try {
        rows = selectCandidateRows(input.db);
    }
    catch (error) {
        summary.failed += 1;
        reportFailure(input.diagnostics, { stage: 'scan', error: describeError(error) });
        return reportSummary(input.diagnostics, summary);
    }
    const context = repairContext(input);
    for (const row of rows) {
        summary.scanned += 1;
        const outcome = await repairCandidateRow({ input, row, context });
        recordCandidateOutcome(summary, input.diagnostics, outcome);
    }
    return reportSummary(input.diagnostics, summary);
}
function createSummary() {
    return { scanned: 0, repaired: 0, repairedSessionIds: [], failed: 0, skipped: {} };
}
function selectCandidateRows(db) {
    return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.columnarVersion, CURRENT_SESSION_COLUMNAR_VERSION), eq(sessions.runtime, 'pi-agent'), eq(sessions.sessionType, 'root'), eq(sessions.sessionKind, 'conversation'), eq(sessions.archived, 0), eq(sessions.isDefaultWorkspace, 1)))
        .all();
}
async function repairCandidateRow(input) {
    try {
        const record = decodeSessionRow(input.row);
        const staticReason = staticSkipReason(record);
        if (staticReason)
            return { kind: 'skipped', reason: staticReason };
        const context = input.context;
        if (!context)
            return { kind: 'skipped', reason: 'runtime-workspace-unavailable' };
        const agent = await input.input.rootAgents.get(record.agentName);
        if (!agent)
            return { kind: 'skipped', reason: 'agent-owner-mismatch' };
        const agentReason = matchingAgentReason(record, agent);
        if (agentReason)
            return { kind: 'skipped', reason: agentReason };
        const workspaceReason = projectWorkspaceReason({ record, agent, ...context });
        if (workspaceReason)
            return { kind: 'skipped', reason: workspaceReason };
        const result = input.input.db.transaction((tx) => repairCandidateInTransaction({ tx, record, agent, ...context }), { behavior: 'immediate' });
        return result === 'repaired'
            ? { kind: 'repaired', sessionId: record.sessionId }
            : { kind: 'skipped', reason: result };
    }
    catch (error) {
        return {
            kind: 'failed',
            failure: {
                stage: 'candidate',
                error: describeError(error),
                sessionId: input.row.sessionId,
                ...(input.row.agentName ? { agentName: input.row.agentName } : {}),
            },
        };
    }
}
function recordCandidateOutcome(summary, diagnostics, outcome) {
    if (outcome.kind === 'repaired') {
        summary.repaired += 1;
        summary.repairedSessionIds.push(outcome.sessionId);
        return;
    }
    if (outcome.kind === 'skipped') {
        skip(summary, outcome.reason);
        return;
    }
    summary.failed += 1;
    reportFailure(diagnostics, outcome.failure);
}
function repairContext(input) {
    try {
        const dataDir = normalizeAbsolutePath(input.dataDir);
        const defaultWorkspaceDir = normalizeAbsolutePath(input.defaultWorkspaceDir());
        return dataDir && defaultWorkspaceDir ? { dataDir, defaultWorkspaceDir } : undefined;
    }
    catch {
        return undefined;
    }
}
function staticSkipReason(record) {
    if (record.runtime !== 'pi-agent' ||
        record.sessionType !== 'root' ||
        record.sessionKind !== 'conversation' ||
        record.archived ||
        record.parentSessionId !== null ||
        record.origin !== 'root-repair' ||
        record.isDefaultWorkspace !== true ||
        record.runLocation !== undefined) {
        return 'unproven-session';
    }
    return isPrimarySessionAgentName(record.agentName) ? 'primary-agent' : undefined;
}
function matchingAgentReason(record, agent) {
    if (agent.agentName !== record.agentName)
        return 'agent-owner-mismatch';
    if (agent.rootSessionId !== record.sessionId)
        return 'agent-root-mismatch';
    return normalizeAbsolutePath(agent.defaultWorkspaceDir)
        ? undefined
        : 'agent-workspace-unavailable';
}
function projectWorkspaceReason(input) {
    const workspaceDir = matchingAgentProjectWorkspace(input.record, input.agent);
    if (!workspaceDir)
        return 'agent-workspace-mismatch';
    return (runtimeWorkspaceReason({
        workspaceDir,
        record: input.record,
        dataDir: input.dataDir,
        defaultWorkspaceDir: input.defaultWorkspaceDir,
    }) ??
        agentInternalWorkspaceReason({ workspaceDir, record: input.record, dataDir: input.dataDir }));
}
function matchingAgentProjectWorkspace(record, agent) {
    const workspaceDir = normalizeAbsolutePath(record.workspaceDir);
    const agentWorkspaceDir = normalizeAbsolutePath(agent.defaultWorkspaceDir);
    if (!workspaceDir || !agentWorkspaceDir)
        return undefined;
    return samePath(workspaceDir, agentWorkspaceDir) ? workspaceDir : undefined;
}
function runtimeWorkspaceReason(input) {
    if (!hasMatchingPathFlavor(input.workspaceDir, input.dataDir, input.defaultWorkspaceDir)) {
        return 'workspace-flavor-mismatch';
    }
    if (!canonicalProjectWorkspaceDir(input.workspaceDir))
        return 'workspace-not-project';
    if (samePath(input.workspaceDir, input.defaultWorkspaceDir))
        return 'runtime-default-workspace';
    if (isWithinDirectory(input.workspaceDir, input.dataDir))
        return 'runtime-data-workspace';
    return isSessionDefaultWorkspaceDir(input.workspaceDir, input.record.sessionId)
        ? 'session-default-workspace'
        : undefined;
}
function hasMatchingPathFlavor(workspaceDir, dataDir, defaultWorkspaceDir) {
    return (pathFlavor(workspaceDir) === pathFlavor(dataDir) &&
        pathFlavor(workspaceDir) === pathFlavor(defaultWorkspaceDir));
}
function agentInternalWorkspaceReason(input) {
    const internalWorkspaceDir = normalizeAbsolutePath(pathFlavor(input.dataDir).join(input.dataDir, 'agents', input.record.agentName, 'workspace'));
    if (!internalWorkspaceDir)
        return undefined;
    return isAgentInternalDefaultWorkspaceDir(input.workspaceDir, internalWorkspaceDir, input.record.agentName)
        ? 'agent-internal-workspace'
        : undefined;
}
function repairCandidateInTransaction(input) {
    const current = readCurrentCandidate(input);
    if (typeof current === 'string')
        return current;
    const nextDefinition = readDefinitionRepair(input.tx, current.record, input.agent);
    if (typeof nextDefinition === 'string')
        return nextDefinition;
    writeCandidateRepair(input.tx, current, nextDefinition);
    return 'repaired';
}
function readCurrentCandidate(input) {
    const row = input.tx
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, input.record.sessionId))
        .get();
    if (!row)
        return 'session-missing';
    const current = decodeSessionRow(row);
    const changedReason = changedCandidateReason(input, current);
    return changedReason || { row, record: current };
}
function changedCandidateReason(input, current) {
    const staticReason = staticSkipReason(current);
    if (staticReason)
        return `changed-${staticReason}`;
    if (changedAgentRootReason(current, input.record, input.agent))
        return 'changed-agent-root';
    const workspaceReason = projectWorkspaceReason({
        record: current,
        agent: input.agent,
        dataDir: input.dataDir,
        defaultWorkspaceDir: input.defaultWorkspaceDir,
    });
    if (workspaceReason)
        return `changed-${workspaceReason}`;
    return undefined;
}
function changedAgentRootReason(current, original, agent) {
    return (current.agentName !== agent.agentName ||
        current.sessionId !== agent.rootSessionId ||
        !samePath(current.workspaceDir, original.workspaceDir));
}
function readDefinitionRepair(tx, current, agent) {
    const definitionRow = tx
        .select()
        .from(sessionAgentDefinitions)
        .where(eq(sessionAgentDefinitions.sessionId, current.sessionId))
        .get();
    return definitionRow ? repairDefinition({ definitionRow, current, agent }) : undefined;
}
function writeCandidateRepair(tx, current, nextDefinition) {
    const projection = encodeSessionRow({ ...current.record, isDefaultWorkspace: false }, { preservedRecordJson: current.row.recordJson, projectId: current.row.projectId });
    tx
        .update(sessions)
        .set({
        projectWorkspaceDir: projection.projectWorkspaceDir,
        isDefaultWorkspace: projection.isDefaultWorkspace,
    })
        .where(eq(sessions.sessionId, current.record.sessionId))
        .run();
    writeDefinitionRepair(tx, current.record.sessionId, nextDefinition);
}
function writeDefinitionRepair(tx, sessionId, nextDefinition) {
    if (!nextDefinition)
        return;
    tx
        .update(sessionAgentDefinitions)
        .set({ definitionJson: nextDefinition.definitionJson })
        .where(eq(sessionAgentDefinitions.sessionId, sessionId))
        .run();
}
function repairDefinition(input) {
    let definition;
    try {
        definition = decodeSessionAgentDefinition(input.definitionRow).definition;
    }
    catch {
        return 'invalid-agent-definition';
    }
    if (!isCurrentSessionAgentDefinition(definition))
        return 'legacy-agent-definition';
    if (definition.exactOwnerName !== input.agent.agentName ||
        definition.project.isDefaultWorkspace !== true ||
        !samePath(definition.project.workspaceDir, input.current.workspaceDir)) {
        return 'agent-definition-mismatch';
    }
    return serializeSessionAgentDefinition({
        definition: {
            ...definition,
            project: { ...definition.project, isDefaultWorkspace: false },
        },
    });
}
function samePath(left, right) {
    const normalizedLeft = normalizeAbsolutePath(left);
    const normalizedRight = normalizeAbsolutePath(right);
    if (!normalizedLeft || !normalizedRight || pathFlavor(normalizedLeft) !== pathFlavor(normalizedRight)) {
        return false;
    }
    return pathFlavor(normalizedLeft) === pathFlavor('C:\\')
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
function isWithinDirectory(value, directory) {
    if (pathFlavor(value) !== pathFlavor(directory))
        return false;
    const windows = pathFlavor(value) === pathFlavor('C:\\');
    const candidate = windows ? value.toLowerCase() : value;
    const parent = windows ? directory.toLowerCase() : directory;
    const separator = windows ? '\\' : '/';
    return candidate === parent || candidate.startsWith(`${parent}${separator}`);
}
function skip(summary, reason) {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
}
function reportSummary(diagnostics, summary) {
    const result = {
        scanned: summary.scanned,
        repaired: summary.repaired,
        repairedSessionIds: [...summary.repairedSessionIds],
        failed: summary.failed,
        skipped: { ...summary.skipped },
    };
    try {
        diagnostics?.reportSummary(result);
    }
    catch {
        // Startup repair diagnostics must not affect SessionSystem readiness.
    }
    return result;
}
function reportFailure(diagnostics, entry) {
    try {
        diagnostics?.reportFailure(entry);
    }
    catch {
        // Startup repair diagnostics must not affect subsequent candidates.
    }
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=_migration-root-project-history-repair.js.map