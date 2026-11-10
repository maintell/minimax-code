export function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
export function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function membership(value) {
    const data = record(value.data) ?? value;
    const subscribed = value.has_token_plan ?? data.has_token_plan;
    return {
        hasTokenPlan: typeof subscribed === 'boolean' ? subscribed : undefined,
        groupId: text(value.op_group_id ?? data.op_group_id),
    };
}
export function personalWorkspace(value) {
    const data = record(value.data) ?? value;
    if (!Array.isArray(data.workspaces))
        return undefined;
    for (const item of data.workspaces) {
        const workspace = record(item);
        if (!workspace || workspace.workspace_type !== 0)
            continue;
        const id = workspace.workspace_id;
        if (text(id) !== undefined || (typeof id === 'number' && Number.isFinite(id) && id >= 0)) {
            return { id: id, membership: membership(workspace) };
        }
    }
    return undefined;
}
/** general 为文本共享额度；缺失时只接受模型精确匹配，避免把媒体额度当作文本额度。 */
export function projectQuota(body, modelName) {
    const data = record(body.data) ?? body;
    const items = Array.isArray(data.model_remains) ? data.model_remains : [];
    const models = items.map(record).filter((item) => item !== undefined);
    const modelId = modelName.slice(modelName.indexOf('/') + 1).toLowerCase();
    const primary = models.find((item) => text(item.model_name)?.toLowerCase() === 'general') ??
        models.find((item) => text(item.model_name)?.toLowerCase() === modelId && !/video/iu.test(modelId));
    if (!primary)
        return { status: 'unknown', reason: 'text-quota-unavailable' };
    const fiveHour = quotaWindow(primary, 'interval');
    const weekly = quotaWindow(primary, 'weekly');
    if (fiveHour === 'unknown' && weekly === 'unknown') {
        return { status: 'unknown', reason: 'quota-windows-unavailable' };
    }
    return { status: 'available', fiveHour, weekly };
}
function quotaWindow(value, kind) {
    const prefix = `current_${kind}`;
    if (value[`${prefix}_status`] === 3)
        return 'unlimited';
    const explicit = value[`${prefix}_remaining_percent`];
    if (explicit !== undefined)
        return percentage(explicit);
    const total = finite(value[`${prefix}_total_count`]);
    // 旧 remains 协议中的 usage_count 表示剩余量，与 SDK used_percent 语义相反。
    const remaining = finite(value[`${prefix}_usage_count`]);
    if (total === undefined || total <= 0 || remaining === undefined)
        return 'unknown';
    return percentage((remaining / total) * 100);
}
function percentage(value) {
    const number = finite(value);
    return number !== undefined && number >= 0 && number <= 100 ? number : 'unknown';
}
//# sourceMappingURL=projection.js.map