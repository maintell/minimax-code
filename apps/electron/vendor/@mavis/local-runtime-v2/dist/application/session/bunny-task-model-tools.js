const modelRef = (model) => `${model.providerId}/${model.modelId}`;
const describeModel = (model) => `${model.displayName}（${modelRef(model)}）`;
function taskModelError(code, message) {
    return Object.assign(new Error(message), { status: 409, code });
}
/**
 * Bunny's read and write of the task model. The user decides the model
 * (MCT-202611-KWIJTTR0): a name is saved only when it is exactly a catalog model's name, id or
 * provider/model, never the nearest one, and anything else leaves the setting as it was.
 */
export function taskModelTools(options) {
    const { bunny, listModels, requireCaller, logger } = options;
    const catalog = async () => {
        try {
            return ((await listModels?.()) ?? []).filter((model) => model.enabled);
        }
        catch (error) {
            logger.warn({ error }, 'Bunny task model catalog read failed');
            return [];
        }
    };
    return {
        listTaskModels: async ({ callerSessionId }) => {
            await requireCaller(callerSessionId);
            const [current, models] = await Promise.all([bunny.taskModel(), catalog()]);
            return {
                ...(current
                    ? { current: { providerId: current.providerId, modelId: current.modelId } }
                    : {}),
                models: models.map(({ displayName, providerId, modelId }) => ({
                    name: displayName,
                    providerId,
                    modelId,
                })),
            };
        },
        setTaskModel: async ({ callerSessionId, model }) => {
            await requireCaller(callerSessionId);
            const wanted = model.trim();
            const models = await catalog();
            if (!models.length)
                throw taskModelError('BUNNY_TASK_MODEL_CATALOG_UNAVAILABLE', `现在读不到可选模型，无法核对“${wanted}”，任务模型没有改。`);
            const byRef = models.filter((entry) => modelRef(entry) === wanted);
            const matches = byRef.length
                ? byRef
                : models.filter((entry) => entry.displayName === wanted || entry.modelId === wanted);
            const [match] = matches;
            if (!match)
                throw taskModelError('BUNNY_TASK_MODEL_NOT_FOUND', `没找到模型“${wanted}”，任务模型没有改。可选的模型：${models.map(describeModel).join('、')}`);
            if (matches.length > 1)
                throw taskModelError('BUNNY_TASK_MODEL_AMBIGUOUS', `“${wanted}”对应多个模型，任务模型没有改。请用户选一个：${matches.map(describeModel).join('、')}`);
            const { providerId, modelId } = match;
            const saved = await bunny.taskModel();
            // Choosing the saved model again keeps the effort the user set for it.
            if (saved?.providerId !== providerId || saved.modelId !== modelId)
                await bunny.setTaskModel({ providerId, modelId });
            const readBack = await bunny.taskModel();
            if (readBack?.providerId !== providerId || readBack.modelId !== modelId)
                throw taskModelError('BUNNY_TASK_MODEL_READBACK_FAILED', `任务模型保存后回读对不上：想存 ${modelRef(match)}，读到 ${readBack ? modelRef(readBack) : '空'}。`);
            return { model: { name: match.displayName, providerId, modelId }, confirmed: true };
        },
    };
}
//# sourceMappingURL=bunny-task-model-tools.js.map