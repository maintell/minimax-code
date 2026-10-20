/**
 * Built-in adapters from domain-owned agent modules to `@mavis/agent-runtime`.
 *
 * This package owns only SPI glue. It does not construct module instances,
 * choose a host profile, or provide a default extension list.
 */
export { sessionReportExtension } from './session-report.js';
export { contextManagerExtension, } from './context-manager.js';
export { permissionExtension, } from './permission.js';
export { skillsExtension } from './skills.js';
export { systemReminderExtension, } from './system-reminder.js';
export { toolOutputBudgetExtension, } from './tool-output-budget.js';
export { requestMediaExtension } from './request-media.js';
export { runawayGuardExtension, runawayGuardShadowExtension, replayRunawayGuardTrajectory, } from './runaway-guard.js';
export { terminalResponseRecoveryExtension, } from './terminal-response-recovery.js';
export { outputLimitRecoveryExtension, } from './output-limit-recovery.js';
export { appSourceAdapter, fileSourceAdapter, mcpSourceAdapter, SOURCE_REFERENCE_DETAILS_KEY, SOURCE_REFERENCE_MARKER_TAG, sourceReferenceExtension, } from './source-reference.js';
export { PLAN_MODE_GUIDANCE, planModeExtension, renderPlanModeReminder, } from './plan-mode.js';
export { MiniAppLifecycleError, createMiniAppControlExtension, } from './miniapp.js';
//# sourceMappingURL=index.js.map