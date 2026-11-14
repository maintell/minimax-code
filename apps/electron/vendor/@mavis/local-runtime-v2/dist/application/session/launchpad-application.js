import { publishBestEffort } from '../events.js';
import { MiniAppIdeas, } from './miniapp-ideas.js';
import { isLaunchpadErrorCode, } from '@mavis/shared/miniapp-launchpad';
import { initializeMiniAppLaunchpad, } from '../../service/miniapp-launchpad/index.js';
import { MiniAppCreationWorkflow, } from './miniapp-creation-workflow.js';
/** Owns creation records; execution remains in ordinary Sessions. */
export class LaunchpadApplication {
    options;
    store;
    closed = false;
    ideas;
    creation;
    constructor(options) {
        this.options = options;
        this.store = initializeMiniAppLaunchpad(options.db, options.deployment, (accountId) => publishBestEffort(options.publish, {
            type: 'miniapp.launchpad.updated',
            payload: { accountId },
        }));
        if (options.suggestIdeas)
            this.ideas = new MiniAppIdeas(options.applications, options.suggestIdeas.complete, options.suggestIdeas.readUserInputs, async (accountId, candidates) => this.store.linkedSessionIds(accountId, candidates));
        this.creation = new MiniAppCreationWorkflow(this.store, options);
    }
    async ensureHostSession(accountId, isCurrent) {
        if (this.closed || !isCurrent())
            throw new Error('unavailable');
        return this.store.ensureHostSession(accountId, async (purpose) => {
            if (this.closed || !isCurrent())
                throw new Error('unavailable');
            const { sessionId } = await this.options.applications.session.lifecycle.createSession({}, {
                name: 'mavis',
                purpose,
                visibility: 'hidden',
                title: 'Mini App',
                teamModeOff: true,
            });
            if (!sessionId)
                throw new Error('failed');
            return sessionId;
        });
    }
    async request(request) {
        if (this.closed)
            return { ok: false, code: 'unavailable' };
        const { command, accountId } = request;
        try {
            if (command.action === 'creation-ideas') {
                if (!this.ideas)
                    return { ok: false, code: 'unavailable' };
                const ideas = await this.ideas.read(request.accountId, command.language);
                return this.closed ? { ok: false, code: 'unavailable' } : { ok: true, ideas };
            }
            return await this.store.transaction(request.accountId, creationSelection(command), async (state) => {
                if (this.closed)
                    return { ok: false, code: 'unavailable' };
                if (command.action === 'list' || command.action === 'creation-get')
                    return this.read(accountId, command, state);
                return this.execute(accountId, command, state);
            });
        }
        catch (error) {
            return launchpadFailure(error);
        }
    }
    async read(accountId, command, state) {
        if (await this.creation.reconcile(accountId, state))
            await this.store.write(accountId, state);
        if (command.action === 'list')
            return {
                ok: true,
                state: {
                    creations: this.store.summaries(accountId),
                },
            };
        const creation = state.creations?.find((item) => command.creationId !== undefined
            ? item.id === command.creationId
            : item.sessionId === command.sessionId);
        if (!creation)
            throw new Error('invalid_request');
        return { ok: true, creation };
    }
    async execute(accountId, command, state) {
        await this.creation.execute(accountId, command, state);
        await this.store.write(accountId, state);
        if (command.action === 'creation-stop' || command.action === 'creation-remove')
            return { ok: true };
        const creation = state.creations?.find((item) => command.action === 'creation-maintenance'
            ? item.pluginId === command.pluginId
            : item.id === ('creationId' in command ? command.creationId : command.requestId));
        if (!creation)
            throw new Error('invalid_request');
        return { ok: true, creation };
    }
    async close() {
        this.closed = true;
        this.ideas?.close();
        this.creation.close();
    }
}
function creationSelection(command) {
    if (command.action === 'creation-start')
        return { kind: 'create', id: command.requestId };
    if (command.action === 'creation-maintenance')
        return { kind: 'plugin', pluginId: command.pluginId };
    if ('creationId' in command && command.creationId !== undefined)
        return { kind: 'id', id: command.creationId };
    if (command.action === 'creation-get' && command.sessionId !== undefined)
        return { kind: 'session', sessionId: command.sessionId };
    return { kind: 'unfinished' };
}
function launchpadFailure(error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'BUSY')
        return { ok: false, code: 'busy' };
    if (error instanceof Error && isLaunchpadErrorCode(error.message))
        return { ok: false, code: error.message };
    return { ok: false, code: 'failed' };
}
//# sourceMappingURL=launchpad-application.js.map