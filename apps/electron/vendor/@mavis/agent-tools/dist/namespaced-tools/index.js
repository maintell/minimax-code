/**
 * Host-neutral namespaced-tool surface: the builtin namespace <-> Skill
 * mapping the tool catalog and the Skill catalog must agree on, the
 * mavis-backed tool plumbing that resolves a namespaced call back to the
 * mavis call it stands for, and the session_create scope rule the permission
 * gate and the Runtime's project approval share. Every module behind this
 * entry is pure (no Node IO, no process state); the closure test in
 * test/shared/neutral-subpaths keeps it that way. The files stay under
 * desktop/ because Desktop tools import them by relative path.
 */
export { BUILTIN_NAMESPACED_TOOL_NAMES, coordinatorHiddenToolNames, coordinatorPreloadSkillNames, isPtcTopLevelNamespacedToolName, namespaceForSkill, namespaceMetricLabel, namespacesUnlockingToolName, PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES, sharedReadsForNamespace, skillForNamespace, } from '../shared/builtin-tool-namespaces.js';
export { isMavisBackedTool, mavisBackedToolForCommand, mavisCoordinatorRefusal, mavisExecutorOnlyTools, mavisHookMatcherAliases, mavisToolMovedMessage, mavisToolMovedRefusalTool, MAVIS_BACKED_TOOL_COMMANDS, MAVIS_BACKED_TOOL_NAMES, readMavisBackedTarget, resolveMavisChildCall, } from '../desktop/local-mavis-namespaced-tools.js';
export { BUNNY_SPACE_TOOL_NAMES } from '../desktop/local-bunny-space-tools.js';
export { coordinatorHiddenToolRefusal } from '../desktop/local-coordinator-tool-refusal.js';
export { namesSessionCreateScope, readSessionCreateScope, } from '../desktop/session-create-scope.js';
export { ASSIGNMENT_RULE_TOOL_NAMES, ASSIGNMENT_TOOL_COMMANDS, assignmentApprovalCommand, isProjectApprovedAssignmentTool, needsAssignmentProjectApproval, } from '../desktop/assignment-project-approval.js';
export { LocalMavisToolDef } from '../desktop/builtin-defs.js';
export { desktopToolFailure, isDesktopToolErrorCode, } from '../desktop/desktop-tool-result.js';
//# sourceMappingURL=index.js.map