import { NotImplementedError, AppError } from '../errors.js';
import { HTTPException } from 'hono/http-exception';
import { SkillEvolveControllerBase } from '../generated/skill-evolve-controller-base.gen.js';
export class SkillEvolveController extends SkillEvolveControllerBase {
    execute;
    constructor(execute = async () => {
        throw new NotImplementedError('SkillEvolve');
    }) {
        super();
        this.execute = execute;
    }
    async invoke(input) {
        const result = await this.execute(input);
        if (result.status >= 400)
            throw new HTTPException(result.status, {
                res: Response.json(result.body, { status: result.status }),
            });
        return { resultJson: JSON.stringify(result.body) };
    }
    getSkillEvolveUsage(_ctx, req) {
        void req;
        return this.invoke({ operation: 'usage' });
    }
    reportSkillEvolveSignal(_ctx, req) {
        void req;
        return this.invoke({ operation: 'signal', body: parseBody(req.bodyJson) });
    }
    cancelSkillEvolveSignal(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'signal/cancel',
            body: { signalId: req.signalId, reason: req.reason },
        });
    }
    listSkillEvolveSignals(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'signals',
            query: {
                verdict: req.verdict,
                skillRef: req.skillRef,
                attribution: req.attribution,
                agentName: req.agentName,
                channel: req.channel,
                limit: req.limit,
                offset: req.offset,
            },
        });
    }
    reportSkillEvolveProposal(_ctx, req) {
        void req;
        return this.invoke({ operation: 'proposal', body: parseBody(req.bodyJson) });
    }
    cancelSkillEvolveProposal(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'proposal/cancel',
            body: { proposalId: req.proposalId, reason: req.reason },
        });
    }
    markSkillEvolveProposalActed(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'proposal/mark-acted',
            body: { proposalId: req.proposalId, skillRef: req.skillRef },
        });
    }
    listSkillEvolveProposals(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'proposals',
            query: {
                verdict: req.verdict,
                skillRef: req.skillRef,
                attribution: req.attribution,
                agentName: req.agentName,
                channel: req.channel,
                limit: req.limit,
                offset: req.offset,
            },
        });
    }
    getSkillEvolveProposal(_ctx, req) {
        void req;
        return this.invoke({ operation: 'get-proposal', id: req.proposalId });
    }
    getSkillEvolveHistory(_ctx, req) {
        void req;
        return this.invoke({
            operation: 'history',
            query: { skill: req.skill, agent: req.agent, limit: req.limit },
        });
    }
    triggerSkillEvolve(_ctx, req) {
        void req;
        return this.invoke({ operation: 'trigger', body: parseBody(req.bodyJson) });
    }
    requestSkillEvolveScan(_ctx, req) {
        void req;
        return this.invoke({ operation: 'scan-request', body: parseBody(req.bodyJson) });
    }
    revertSkillEvolve(_ctx, req) {
        void req;
        return this.invoke({ operation: 'revert', body: parseBody(req.bodyJson) });
    }
    mutateSkillEvolveLifecycle(_ctx, req) {
        void req;
        return this.invoke({ operation: 'lifecycle', action: req.action });
    }
}
function parseBody(raw) {
    try {
        const value = JSON.parse(raw);
        if (value && typeof value === 'object' && !Array.isArray(value))
            return value;
    }
    catch {
        /* Invalid JSON is a contract error, not an empty mutation. */
    }
    throw new AppError(400, 'INVALID_EVOLVE_BODY', 'body_json must contain a JSON object');
}
//# sourceMappingURL=skill-evolve.controller.js.map