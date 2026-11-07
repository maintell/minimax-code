import {} from '@mavis/cron';
import { json, notFound } from '../../../infra/transport/host-http.js';
import {} from './execution/runtime.js';
import { localCronScheduler } from './execution/runtime-contracts.js';
export async function routeLocalCronApi(input) {
    await input.runtime.ensureStarted('legacy_cron_route');
    const tail = input.parts.slice(1);
    if (input.method === 'GET' && tail.length === 0) {
        const taskStates = input.runtime.cronConsumerEnabled
            ? input.runtime.registry.listAllTasks()
            : await listStoredCronTasks(input.runtime.cronStore);
        const tasks = taskStates.map(toCronResponse);
        return json({ tasks, count: tasks.length });
    }
    if (input.method === 'GET' && tail.length === 1 && tail[0] === 'sessions') {
        const sessions = await input.listAllSessions(undefined, {
            includeHidden: true,
            includePurposePrefix: 'cron:',
            limit: readPositiveInt(new URL(input.request.url).searchParams.get('limit')) ?? 200,
        });
        return json({
            sessions: sessions.map((session) => ({
                id: session.sessionId,
                agentId: session.agentName,
                purpose: session.purpose,
                title: session.title ?? null,
                status: session.status,
                created_at: session.createdAtMs,
            })),
        });
    }
    return notFound(`/cron/${tail.join('/')}`);
}
function toCronResponse(state) {
    return {
        cronName: state.cronName,
        agentName: state.agentName,
        ...(state.cronId ? { cronId: state.cronId } : {}),
        schedule: state.config.schedule,
        ...(state.config.scheduleType !== 'cron' ? { scheduleType: state.config.scheduleType } : {}),
        ...(state.config.runAtMs !== undefined ? { runAtMs: state.config.runAtMs } : {}),
        ...(state.config.deleteAfterRun !== undefined
            ? { deleteAfterRun: state.config.deleteAfterRun }
            : {}),
        timezone: state.config.timezone,
        enabled: state.enabled,
        prompt: state.config.prompt,
        session: state.config.session,
        delivery: state.config.delivery,
        reportToRoot: false,
        reportToMain: false,
        activeHours: state.config.activeHours,
        status: state.status,
        lastRun: state.lastRun,
        lastResult: state.lastResult,
        lastError: state.lastError,
        nextRun: state.nextRun,
    };
}
export async function listStoredCronTasks(store, agentName) {
    const entries = agentName ? await store.listByAgent(agentName) : await store.listAll();
    return entries.map(cronLoadResultToState);
}
export async function getStoredCronTask(store, agentName, cronName) {
    const entries = await store.listByAgent(agentName);
    const entry = entries.find((candidate) => candidate.cronName === cronName);
    return entry ? cronLoadResultToState(entry) : undefined;
}
export async function createStoredCronTask(store, agentName, cronName, config) {
    localCronScheduler.assertSchedulable(config);
    await store.create(agentName, cronName, config);
    return ((await getStoredCronTask(store, agentName, cronName)) ??
        cronLoadResultToState({
            agentName,
            cronName,
            config,
            configPath: await store.configPath(agentName, cronName),
        }));
}
export async function updateStoredCronTask(store, agentName, cronName, update) {
    const existing = await getStoredCronTask(store, agentName, cronName);
    if (!existing)
        return undefined;
    localCronScheduler.assertSchedulable(applyUpdateForValidation(existing.config, update));
    await store.update(agentName, cronName, update);
    return getStoredCronTask(store, agentName, cronName);
}
export async function deleteStoredCronTask(store, agentName, cronName) {
    const existing = await store.get(agentName, cronName);
    if (!existing)
        return false;
    await store.delete(agentName, cronName);
    return true;
}
function cronLoadResultToState(entry) {
    return {
        agentName: entry.agentName,
        cronName: entry.cronName,
        config: entry.config,
        ...(entry.cronId ? { cronId: entry.cronId } : {}),
        enabled: !entry.config.disabled,
        lastRun: null,
        lastResult: null,
        lastError: null,
        nextRun: null,
        status: 'idle',
    };
}
function applyUpdateForValidation(config, update) {
    return {
        ...config,
        ...(update.disabled !== undefined ? { disabled: update.disabled } : {}),
        ...(update.schedule !== undefined ? { schedule: update.schedule } : {}),
        ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
        ...(update.session !== undefined ? { session: update.session } : {}),
        ...nullableCronField('timezone', update.timezone),
        ...nullableCronField('activeHours', update.activeHours),
        ...nullableCronField('delivery', update.delivery),
        ...nullableCronField('report_to_root', update.report_to_root),
        ...nullableCronField('report_to_main', update.report_to_main),
    };
}
function nullableCronField(key, value) {
    if (value === undefined)
        return {};
    return { [key]: value ?? undefined };
}
function readPositiveInt(raw) {
    if (!raw)
        return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}
export { createLocalCronRuntime, } from './execution/runtime.js';
//# sourceMappingURL=api.js.map