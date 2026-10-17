import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { sessionAgentDefinitions } from '../../../../../infra/db/schema/sessions.js';
import { decodeSessionAgentDefinition, serializeSessionAgentDefinition, } from '../agent-binding.js';
const MODEL_FIELDS = {
    effectiveModelVariant: 'variant',
    effectiveModelThinking: 'thinking',
    effectiveModelContextWindow: 'contextWindow',
    effectiveModelMaxOutputTokens: 'maxOutputTokens',
};
/** Omitted fields survive only when the model identity is unchanged. */
export function normalizeSessionModelUpdate(current, fields) {
    if (typeof fields.effectiveModel !== 'string' || fields.effectiveModel === current.effectiveModel)
        return fields;
    return {
        effectiveModelVariant: null,
        effectiveModelThinking: null,
        effectiveModelContextWindow: null,
        effectiveModelMaxOutputTokens: null,
        ...fields,
    };
}
/** Runs inside the Session row transaction; never reopens the Agent definition. */
export function syncSessionAgentDefinitionModel(db, sessionId, fields) {
    if (!Object.hasOwn(fields, 'effectiveModel') &&
        !Object.keys(MODEL_FIELDS).some((key) => Object.hasOwn(fields, key)))
        return;
    const row = db
        .select()
        .from(sessionAgentDefinitions)
        .where(eq(sessionAgentDefinitions.sessionId, sessionId))
        .get();
    if (!row)
        return;
    const { definition } = decodeSessionAgentDefinition(row);
    if (definition.definitionVersion !== 2)
        return;
    const updated = updateSessionAgentDefinitionModel(definition, fields);
    const serialized = serializeSessionAgentDefinition({ definition: updated });
    db.update(sessionAgentDefinitions)
        .set({ definitionJson: serialized.definitionJson })
        .where(eq(sessionAgentDefinitions.sessionId, sessionId))
        .run();
    // The legacy Task mirror contains only prompt/capabilities, never model fields.
}
function updateSessionAgentDefinitionModel(definition, fields) {
    const model = { ...definition.model };
    applyModelIdentity(model, fields.effectiveModel);
    if (fields.modelParameterSnapshot)
        model.parameterSnapshot = { ...fields.modelParameterSnapshot };
    else if (model.parameterSnapshot) {
        model.parameterSnapshot = {
            ...model.parameterSnapshot,
            ...(Object.hasOwn(fields, 'effectiveModelContextWindow')
                ? { context: fields.effectiveModelContextWindow == null ? 'default' : 'selection' }
                : {}),
            ...(Object.hasOwn(fields, 'effectiveModelThinking')
                ? { effort: fields.effectiveModelThinking?.effort == null ? 'default' : 'selection' }
                : {}),
        };
    }
    applyModelFieldUpdates(model, fields);
    return { ...definition, model };
}
function applyModelIdentity(model, key) {
    if (typeof key !== 'string')
        return;
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1)
        throw new Error('Session model must have a provider/model identity');
    const providerId = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    if (providerId !== model.providerId || modelId !== model.modelId) {
        delete model.parameterSnapshot;
        // Limits and effort belong to their model. Only explicit replacements
        // may follow a changed identity; the catalog resolves any absent limits.
        for (const field of Object.values(MODEL_FIELDS))
            delete model[field];
    }
    model.providerId = providerId;
    model.modelId = modelId;
}
function applyModelFieldUpdates(model, fields) {
    for (const [field, target] of Object.entries(MODEL_FIELDS)) {
        if (!Object.hasOwn(fields, field))
            continue;
        const value = fields[field];
        if (value == null)
            delete model[target];
        else
            Object.assign(model, { [target]: value });
    }
}
/** Called inside the same immediate transaction as the Session and binding update. */
export function assertSessionModelSnapshot(current, expected) {
    if (!expected)
        return;
    const fields = ['effectiveModel', ...Object.keys(MODEL_FIELDS)];
    for (const field of fields) {
        const key = field;
        if (!isDeepStrictEqual(current[key] ?? null, expected[key] ?? null)) {
            throw new Error('Session model changed during repair. Retry with the current selection.');
        }
    }
}
//# sourceMappingURL=model-update.js.map