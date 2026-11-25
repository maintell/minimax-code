/** config.yaml `contextManagement`; invalid values fall back to `defaults` field by field. */
export function parseContextManagementConfig(raw, defaults) {
    const rawCm = raw.contextManagement;
    if (rawCm == null || typeof rawCm !== 'object' || Array.isArray(rawCm)) {
        return {
            disableSystemReminderModels: [...defaults.disableSystemReminderModels],
            cuMaxScreenshotsInContext: defaults.cuMaxScreenshotsInContext,
        };
    }
    const obj = rawCm;
    const rawList = obj.disableSystemReminderModels;
    const disableSystemReminderModels = Array.isArray(rawList) && rawList.every((e) => typeof e === 'string' && e.length > 0)
        ? rawList
        : [...defaults.disableSystemReminderModels];
    const rawCuMax = obj.cuMaxScreenshotsInContext;
    const cuMaxScreenshotsInContext = typeof rawCuMax === 'number' && Number.isFinite(rawCuMax) && rawCuMax >= 0
        ? Math.floor(rawCuMax)
        : defaults.cuMaxScreenshotsInContext;
    // Semantic validation (ratio vs. token count) lives with the trigger in
    // @mavis/context-manager; keep numbers so the runtime can warn on bad ones.
    const compactionTriggerAt = typeof obj.compactionTriggerAt === 'number' ? obj.compactionTriggerAt : undefined;
    return {
        disableSystemReminderModels,
        cuMaxScreenshotsInContext,
        ...(compactionTriggerAt === undefined ? {} : { compactionTriggerAt }),
    };
}
//# sourceMappingURL=context-management-config.js.map