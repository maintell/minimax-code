import { logger } from '@mavis/shared/local-runtime-logging';
import { readPreferenceValue, upsertPreferenceValue } from '../../../infra/db/preference-values.js';
import { AgentConfigError } from '../storage/canonical-agent-config.js';
const STARRED_AGENTS_PREFERENCE_KEY = 'starred-agents';
/** Agent-owned persistence and wire projection for the legacy starred route. */
export class AgentFavorites {
    db;
    agents;
    constructor(db, agents) {
        this.db = db;
        this.agents = agents;
    }
    async get() {
        const stored = readPreferenceValue(this.db, STARRED_AGENTS_PREFERENCE_KEY);
        if (!Array.isArray(stored))
            return [];
        const projected = [];
        const seen = new Set();
        for (const value of stored) {
            if (typeof value !== 'string')
                continue;
            const wireRef = await this.projectStarredRef(value);
            if (wireRef === undefined || seen.has(wireRef))
                continue;
            seen.add(wireRef);
            projected.push(wireRef);
        }
        return projected;
    }
    /**
     * Projects one persisted starred entry to its wire ref; `undefined` hides it.
     *
     * A starred Agent whose canonical config no longer parses is isolated
     * per-item, mirroring the roster's fail-soft rule
     * (`inspectCanonicalCustomAgent`): it is hidden from the projection instead
     * of failing the whole favorites read. The isolation sits here — not in
     * `repository.get()` — so exact reads keep their field-level diagnostic.
     * Anything other than the parse failure keeps propagating.
     */
    async projectStarredRef(value) {
        const explicit = value.toLowerCase().startsWith('agent:');
        const exact = explicit ? value.slice('agent:'.length) : value;
        try {
            const owner = await this.agents.getPersistedOwner(exact);
            const executionTarget = await this.agents.resolveAgentExecutionTarget(exact);
            let wireRef = owner?.requestRef ?? exact;
            if (explicit)
                wireRef = `agent:${exact}`;
            if (executionTarget !== exact)
                wireRef = executionTarget;
            return wireRef;
        }
        catch (error) {
            if (!(error instanceof AgentConfigError))
                throw error;
            logger.warn({
                agentName: exact,
                code: error.code,
                message: error.message,
                reason: 'favorite-agent-config-invalid',
            }, 'Starred Agent has an invalid canonical config; skipping it in the favorites projection');
            return undefined;
        }
    }
    async put(requestRefs) {
        const exactOwners = [];
        const seen = new Set();
        for (const requestRef of requestRefs) {
            const exact = await this.agents.resolveAgentWriteTarget(requestRef);
            if (seen.has(exact))
                continue;
            seen.add(exact);
            exactOwners.push(exact);
        }
        upsertPreferenceValue(this.db, STARRED_AGENTS_PREFERENCE_KEY, exactOwners);
        return exactOwners;
    }
}
//# sourceMappingURL=favorites.js.map