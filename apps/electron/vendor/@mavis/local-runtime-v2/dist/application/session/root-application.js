import { RootInvariantError, } from '../../service/session-system/index.js';
import { AgentServiceError } from '../../service/agent/index.js';
import { AppError } from '../errors.js';
import { publishBestEffort } from '../events.js';
import { toSessionInfoView } from './wire.js';
/** Projects the admitted subset of a committed Root replacement. */
export class SessionRootEventProjector {
    options;
    constructor(options) {
        this.options = options;
    }
    observe(fact) {
        for (const previousRoot of fact.previousRoots) {
            publishBestEffort(this.options.publish, {
                type: 'session.title_updated',
                payload: {
                    sessionId: previousRoot.sessionId,
                    agentName: fact.agentName,
                    title: fact.archivedRootTitle,
                },
            });
        }
        publishBestEffort(this.options.publish, {
            type: 'session.title_updated',
            payload: {
                sessionId: fact.nextRoot.sessionId,
                agentName: fact.agentName,
                title: 'Main',
            },
        });
        publishBestEffort(this.options.publish, {
            type: 'agent.updated',
            payload: {
                agentName: fact.agentName,
                agentId: fact.agentName,
                change: 'updated',
            },
        });
    }
}
/** Projects a later committed archive-title refinement without archive-state events. */
export class RootArchiveTitleEventProjector {
    options;
    constructor(options) {
        this.options = options;
    }
    observe(fact) {
        publishBestEffort(this.options.publish, {
            type: 'session.title_updated',
            payload: {
                sessionId: fact.sessionId,
                agentName: fact.agentName,
                title: fact.title,
            },
        });
    }
}
/** Owns generated Root mapping and the source-ordered replacement workflow. */
export class SessionRootApplication {
    options;
    /** Bound late: an owner composed after the applications take part in later Roots. */
    rootParticipant;
    constructor(options) {
        this.options = options;
    }
    /**
     * Registers the participant every later Root runs, on both timings. Owners composed after this
     * application exists bind here rather than through the constructor.
     */
    bindRootParticipant(participant) {
        this.rootParticipant = participant;
    }
    async getRootSession(_context, request) {
        const agentName = await this.resolvePublicAgentName(request.name);
        return {
            session: toSessionInfoView(await this.getRootSessionByAgent(agentName)),
        };
    }
    async replaceRootSession(_context, request) {
        const agentName = await this.resolvePublicAgentName(request.name);
        await this.replaceRootSessionByAgent(agentName, request.sessionId);
        return { ok: true };
    }
    async getRootSessionByAgent(agentName) {
        return this.invoke(async () => {
            const root = await this.options.invariant.getRootSessionByAgent(agentName);
            return this.runRootParticipant(agentName, root, 'ensured');
        });
    }
    async replaceRootSessionByAgent(agentName, nextRootSessionId, options = {}) {
        const { nextRoot } = await this.replaceRootSessionWithResult(agentName, nextRootSessionId, options);
        return nextRoot;
    }
    replaceRootSessionWithResult(agentName, nextRootSessionId, options = {}) {
        return this.invoke(() => this.runReplacement(agentName, nextRootSessionId, options));
    }
    resolvePublicAgentName(requestRef) {
        // `agent:` is an explicit physical-owner request. Let AgentService validate
        // and unwrap it; only bare generated aliases may select the current winner.
        return this.invoke(() => requestRef.trim().toLowerCase().startsWith('agent:')
            ? this.options.requireExactAgentKey(requestRef)
            : this.options.resolveAgentWriteTarget(requestRef));
    }
    async runReplacement(agentName, nextRootSessionId, options) {
        const plan = await this.options.invariant.prepareReplacement(agentName, nextRootSessionId);
        await Promise.all(plan.previousRoots.map((root) => this.abortOldRoot(agentName, root.sessionId)));
        const committed = await this.options.invariant.commitReplacement(plan, options);
        await Promise.all(committed.previousRoots.map((root) => this.runPostCommitParticipants(agentName, root, plan.fallbackName)));
        await this.runRootParticipant(agentName, committed.nextRoot, 'adopted');
        await this.observeFact(committed);
        return { ...committed, fallbackName: plan.fallbackName };
    }
    async abortOldRoot(agentName, sessionId) {
        try {
            await this.options.turn.abort({ sessionId, reason: 'root-session-replaced' });
        }
        catch (error) {
            this.reportBestEffortFailure('turn-abort', agentName, sessionId, error);
        }
    }
    async runPostCommitParticipants(agentName, previousRoot, fallbackName) {
        try {
            this.options.archiveTitle.generate(previousRoot.sessionId, { agentName, fallbackName });
        }
        catch (error) {
            this.reportBestEffortFailure('archive-title', agentName, previousRoot.sessionId, error);
        }
    }
    /**
     * The one place a Root is materialized on, whichever timing produced it. A read hands back the
     * record the participant returns; a replacement already committed and keeps its own.
     */
    async runRootParticipant(agentName, root, reason) {
        const participant = this.rootParticipant;
        if (!participant)
            return root;
        try {
            return (await participant.apply({ agentName, root, reason })) ?? root;
        }
        catch (error) {
            this.reportBestEffortFailure('root-materialized', agentName, root.sessionId, error);
            return root;
        }
    }
    async observeFact(fact) {
        try {
            await this.options.facts?.observe(fact);
        }
        catch (error) {
            this.reportBestEffortFailure('fact-observer', fact.agentName, fact.nextRoot.sessionId, error);
        }
    }
    reportBestEffortFailure(stage, agentName, sessionId, error) {
        try {
            this.options.onBestEffortFailure?.({ stage, agentName, sessionId, error });
        }
        catch {
            // The Root mutation committed or the participant is independently retryable.
        }
    }
    async invoke(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof RootInvariantError)
                throw rootApplicationError(error);
            if (error instanceof AgentServiceError) {
                throw new AppError(error.status, error.code, error.message);
            }
            throw error;
        }
    }
}
function rootApplicationError(error) {
    switch (error.reason) {
        case 'agent-not-found':
            return new AppError(404, 'AGENT_NOT_FOUND', error.message);
        case 'replacement-not-found':
            return new AppError(404, 'ROOT_SESSION_NOT_FOUND', error.message);
    }
}
//# sourceMappingURL=root-application.js.map