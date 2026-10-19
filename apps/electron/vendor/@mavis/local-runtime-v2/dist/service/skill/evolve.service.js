import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** One owner serializes read/modify/write against the unchanged JSON ledger. */
export class SkillEvolveService {
    dataDir;
    nowMs;
    tail = Promise.resolve();
    constructor(dataDir, nowMs) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async execute(input) {
        const preceding = this.tail;
        let release;
        this.tail = new Promise((resolve) => {
            release = resolve;
        });
        try {
            await preceding;
            return await executeEvolve(input, new LocalSkillEvolveStore(this.dataDir()), this.nowMs);
        }
        finally {
            release();
        }
    }
}
async function executeEvolve(input, store, nowMs) {
    const handler = EVOLVE_HANDLERS[input.operation];
    if (!handler)
        throw new Error('Unknown Skill Evolve operation');
    return handler({
        input,
        store,
        nowMs,
        state: await store.read(),
        body: input.body ?? {},
        query: input.query ?? {},
    });
}
const EVOLVE_HANDLERS = {
    usage: () => json({ usage: {} }),
    signal: reportSignal,
    'signal/cancel': cancelSignal,
    signals: listSignals,
    'proposal/cancel': cancelProposal,
    'proposal/mark-acted': markProposalActed,
    proposal: reportProposal,
    proposals: listProposals,
    'get-proposal': getProposal,
    history: getHistory,
    trigger: triggerEvolution,
    revert: revertEvolution,
    lifecycle: mutateLifecycle,
    'scan-request': triggerEvolution,
};
async function reportSignal({ store, nowMs, state, body, }) {
    const now = nowMs();
    const signal = {
        id: `sig_${randomBytes(6).toString('hex')}`,
        kind: 'signal',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        body,
    };
    state.signals.unshift(signal);
    state.history.unshift({ type: 'signal.created', id: signal.id, at: now });
    await store.write(state);
    const serialized = serializeSignal(signal);
    return json({ signal: serialized, signalId: serialized.signalId }, { status: 201 });
}
async function cancelSignal({ store, nowMs, state, body, }) {
    const signalId = readString(body, 'signalId');
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal)
        return json({ error: `Signal ${signalId ?? ''} not found` }, { status: 404 });
    signal.status = 'dismissed';
    signal.updatedAt = nowMs();
    signal.body = { ...signal.body, cancelReason: readString(body, 'reason') };
    await store.write(state);
    const serialized = serializeSignal(signal);
    return json({ signal: serialized, signalId: serialized.signalId, status: 'dismissed' });
}
function listSignals({ state, query }) {
    return json(pageRecords(state.signals, query, 'signals', serializeSignal));
}
async function cancelProposal({ store, nowMs, state, body, }) {
    const proposalId = readString(body, 'proposalId');
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal)
        return json({ error: `Proposal ${proposalId ?? ''} not found` }, { status: 404 });
    proposal.status = 'dismissed';
    proposal.updatedAt = nowMs();
    proposal.body = { ...proposal.body, cancelReason: readString(body, 'reason') };
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId, status: 'dismissed' });
}
async function markProposalActed({ store, nowMs, state, body, }) {
    const proposalId = readString(body, 'proposalId');
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal)
        return json({ error: `Proposal ${proposalId ?? ''} not found` }, { status: 404 });
    proposal.status = 'acted';
    proposal.updatedAt = nowMs();
    proposal.body = { ...proposal.body, skillRef: readString(body, 'skillRef') };
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId, status: 'acted' });
}
async function reportProposal({ store, nowMs, state, body, }) {
    const now = nowMs();
    const proposal = {
        id: `pro_${randomBytes(6).toString('hex')}`,
        kind: 'proposal',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        body,
    };
    state.proposals.unshift(proposal);
    state.history.unshift({ type: 'proposal.created', id: proposal.id, at: now });
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId }, { status: 201 });
}
function listProposals({ state, query }) {
    return json(pageRecords(state.proposals, query, 'proposals', serializeProposal));
}
function getProposal({ input, state }) {
    const proposal = state.proposals.find((item) => item.id === input.id);
    if (!proposal)
        return json({ error: `Proposal ${input.id} not found` }, { status: 404 });
    return json({ proposal: serializeProposal(proposal) });
}
function getHistory({ state, query }) {
    return json(serializeHistory(state, query));
}
async function triggerEvolution({ input, store, nowMs, state, body, }) {
    const now = nowMs();
    const signal = {
        id: `sig_${randomBytes(6).toString('hex')}`,
        kind: 'signal',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        body: {
            ...body,
            channel: readString(body, 'channel') ?? 'manual',
            issueKind: readString(body, 'issueKind') ?? 'manual-trigger',
            evidenceExcerpt: readString(body, 'evidenceExcerpt') ?? 'Manual skill evolution trigger requested.',
        },
    };
    state.signals.unshift(signal);
    state.history.unshift({ type: `skill-evolve.${input.operation}`, id: signal.id, at: now });
    await store.write(state);
    return json({
        ok: true,
        status: 'queued',
        localRuntime: true,
        signal: serializeSignal(signal),
        decision: null,
    });
}
async function revertEvolution({ store, nowMs, state }) {
    const now = nowMs();
    state.history.unshift({ type: 'skill-evolve.revert', at: now });
    await store.write(state);
    return json({
        ok: false,
        success: false,
        error: 'Skill archive revert is not implemented by embedded local-runtime.',
        code: 'LOCAL_SKILL_REVERT_UNAVAILABLE',
        localRuntime: true,
    }, { status: 501 });
}
async function mutateLifecycle({ input, store, nowMs, state, }) {
    const now = nowMs();
    state.history.unshift({ type: `skill-evolve.lifecycle.${input.action ?? 'unknown'}`, at: now });
    await store.write(state);
    return json({
        ok: false,
        success: false,
        error: 'Skill lifecycle mutations are not implemented by embedded local-runtime.',
        code: 'LOCAL_SKILL_LIFECYCLE_UNAVAILABLE',
        action: input.action ?? 'unknown',
        localRuntime: true,
    }, { status: 501 });
}
class LocalSkillEvolveStore {
    file;
    constructor(dataDir) {
        this.file = join(dataDir, 'local-runtime', 'skill-evolve.json');
    }
    async read() {
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf-8'));
            return {
                signals: Array.isArray(parsed.signals) ? parsed.signals : [],
                proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
                history: Array.isArray(parsed.history) ? parsed.history : [],
            };
        }
        catch {
            return { signals: [], proposals: [], history: [] };
        }
    }
    async write(state) {
        await mkdir(join(this.file, '..'), { recursive: true });
        await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    }
}
function pageRecords(records, query, key, serialize) {
    const limit = clampInt(query['limit'], 50, 1, 200);
    const offset = clampInt(query['offset'], 0, 0, Number.MAX_SAFE_INTEGER);
    const filtered = records.filter((item) => matchesFilters(item, query));
    const items = filtered.slice(offset, offset + limit).map(serialize);
    return {
        [key]: items,
        items,
        total: filtered.length,
        has_more: offset + limit < filtered.length,
        next_offset: offset + limit < filtered.length ? offset + limit : null,
    };
}
function serializeHistory(state, query) {
    const skill = query['skill'] ?? '';
    const agent = query['agent'] ?? null;
    const limit = clampInt(query['limit'], 20, 1, 200);
    const history = state.history.slice(0, limit);
    return {
        skill,
        agent,
        log: history.map(serializeHistoryEntry),
        archives: [],
        history,
        items: history,
    };
}
function serializeHistoryEntry(entry) {
    const at = typeof entry['at'] === 'number' && Number.isFinite(entry['at']) ? entry['at'] : 0;
    return {
        ts: at,
        action: readString(entry, 'type') ?? 'unknown',
        ...(readString(entry, 'id') ? { runId: readString(entry, 'id') } : {}),
        ...(readString(entry, 'rationale') ? { rationale: readString(entry, 'rationale') } : {}),
    };
}
function serializeSignal(record) {
    const issueKind = readString(record.body, 'issueKind') ?? 'other';
    const signal = {
        signalId: record.id,
        createdAt: timestampMs(record.createdAt),
        source: readSource(record.body),
        target: readString(record.body, 'skillRef')
            ? { skillRef: readString(record.body, 'skillRef') }
            : {},
        issueKind,
        evidenceExcerpt: readString(record.body, 'evidenceExcerpt') ?? readString(record.body, 'evidence') ?? '',
        verdict: statusToVerdict(record.status),
    };
    const attribution = readString(record.body, 'attribution') ?? inferAttribution(issueKind);
    if (attribution)
        signal.attribution = attribution;
    const rationale = readString(record.body, 'rationale');
    if (rationale)
        signal.rationale = rationale;
    applyDisposition(record, signal);
    return signal;
}
function serializeProposal(record) {
    const proposal = {
        proposalId: record.id,
        createdAt: timestampMs(record.createdAt),
        source: readSource(record.body),
        suggestedName: readString(record.body, 'suggestedName') ?? '',
        suggestedScope: readString(record.body, 'suggestedScope') ?? 'agent-self',
        summary: readString(record.body, 'summary') ?? '',
        rationale: readString(record.body, 'rationale') ?? '',
        evidenceExcerpts: readStringArray(record.body, 'evidenceExcerpts'),
        verdict: statusToVerdict(record.status),
    };
    const targetAgentName = readString(record.body, 'targetAgentName');
    if (targetAgentName)
        proposal.targetAgentName = targetAgentName;
    const sketch = readString(record.body, 'sketch');
    if (sketch)
        proposal.sketch = sketch;
    applyDisposition(record, proposal);
    const createdSkillRef = readString(record.body, 'skillRef') ?? readString(record.body, 'createdSkillRef');
    if (createdSkillRef)
        proposal.createdSkillRef = createdSkillRef;
    return proposal;
}
function readSource(body) {
    return {
        channel: readString(body, 'channel') ?? 'active',
        sessionId: readString(body, 'sessionId') ?? 'unknown',
        agentName: readString(body, 'agentName') ?? 'unknown',
    };
}
function matchesFilters(record, query) {
    const source = readSource(record.body);
    const filters = [
        [query['verdict'], statusToVerdict(record.status)],
        [query['skillRef'], readString(record.body, 'skillRef')],
        [query['attribution'], readString(record.body, 'attribution')],
        [query['agentName'], source.agentName],
        [query['channel'], source.channel],
    ];
    return filters.every(([expected, actual]) => !expected || expected === actual);
}
function applyDisposition(record, result) {
    if (record.status !== 'pending')
        result.actedAt = timestampMs(record.updatedAt);
    const dismissReason = readString(record.body, 'cancelReason') ?? readString(record.body, 'dismissReason');
    if (dismissReason)
        result.dismissReason = dismissReason;
}
function statusToVerdict(status) {
    if (status === 'acted')
        return 'acted';
    if (status === 'dismissed')
        return 'dismissed';
    return 'pending';
}
function inferAttribution(issueKind) {
    return issueKind === 'missing-step' ||
        issueKind === 'bad-default' ||
        issueKind === 'wrong-trigger'
        ? 'skill_issue'
        : undefined;
}
function readStringArray(body, key) {
    const value = body[key];
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [];
}
function timestampMs(ms) {
    return Number.isFinite(ms) ? ms : 0;
}
function json(body, options) {
    return { body, status: options?.status ?? 200 };
}
function readString(body, key) {
    const value = body[key];
    return typeof value === 'string' && value ? value : undefined;
}
function clampInt(raw, fallback, min, max) {
    const value = raw == null ? fallback : Number.parseInt(raw, 10);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.min(max, value));
}
//# sourceMappingURL=evolve.service.js.map