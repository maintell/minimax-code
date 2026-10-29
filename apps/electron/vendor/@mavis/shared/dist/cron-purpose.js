/** Cron task name used for the daemon-managed memory cleanup automation. */
export const MEMORY_CLEANUP_CRON_NAME = 'memory-cleanup';
/** Stable prefix for sessions created by cron-like background automations. */
export const CRON_SESSION_PURPOSE_PREFIX = 'cron:';
/** Build a machine-readable purpose for sessions spawned by a cron-like task. */
export function createCronSessionPurpose(agentName, cronName) {
    return `${CRON_SESSION_PURPOSE_PREFIX}${agentName}:${cronName}`;
}
/** Format the user-visible title for a Cron-created session. */
export function formatCronRunTitle(cronName, _input) {
    return cronName;
}
/** Parse `cron:<agentName>:<cronName>` purpose values written into session metadata. */
export function parseCronSessionPurpose(purpose) {
    if (!purpose?.startsWith(CRON_SESSION_PURPOSE_PREFIX))
        return null;
    const parts = purpose.slice(CRON_SESSION_PURPOSE_PREFIX.length).split(':');
    if (parts.length < 2)
        return null;
    const [agentName, ...rest] = parts;
    const cronName = rest.join(':');
    return agentName && cronName ? { agentName, cronName } : null;
}
/** Legacy memory-cleanup sessions predate machine-readable cron purpose metadata. */
export function isLegacyMemoryCleanupTitle(title) {
    return /^Memory cleanup \d{4}-\d{2}-\d{2}$/.test(title ?? '');
}
/** 自提醒沿用独立的 Cron ID 格式，普通 Cron 使用 UUID。 */
export function isSelfReminderId(cronId) {
    return /^self-[a-f0-9]{32}$/.test(cronId ?? '');
}
/** 云端自提醒占用的保留名称前缀，与 archon_server 的 `selfReminderNamePrefix` 一致。 */
export const SELF_REMINDER_NAME_PREFIX = '@self-reminder/';
/** 云端按保留名称识别自提醒；名称是会话摘要，只用于唯一性，不展示给用户。 */
export function isSelfReminderName(cronName) {
    return (cronName ?? '').trim().toLowerCase().startsWith(SELF_REMINDER_NAME_PREFIX);
}
/** 自提醒的用户可见名称。本地运行时写入定义，云端由 UI 按任务 ID 生成。 */
export function formatSelfReminderName(reminderId) {
    return `Task follow-up (${reminderId.slice(-8)})`;
}
//# sourceMappingURL=cron-purpose.js.map