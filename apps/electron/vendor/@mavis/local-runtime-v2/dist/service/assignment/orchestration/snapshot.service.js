import path from 'node:path';
import { BUNNY_AGENT_NAME } from '../../bunny/index.js';
import { renderWakeLine } from '../../turn-system/index.js';
import { escapeAssignmentData, mcodeStateBlock, panelViewLine, recentProjectLine, spaceOverviewLine, STALE_STATE_LINE, STATE_NONE, STATE_SECTIONS, stateTimeLine, TASK_STOPPED_DETAIL, taskRow, taskTakenOverDetail, } from '../../coordinator-text/index.js';
import { renderTaskDelta } from '../state/task-delta.js';
import { renderContextDelta } from '../state/context-delta.js';
import { OptionalReads, owedParts, settleOwed, } from '../state/unreadable-items.js';
import { taskErrorReason } from '../state/task-error-reason.js';
/** Baseline key of the space the Bunny panel showed. */
const UI_SPACE_KEY = 'ui:space';
/** Baseline key prefix of a working-state ledger entry. */
const LEDGER_KEY = 'ledger:';
/**
 * Bunny's delta block (spec 9): the wake line, then everything outside Bunny's
 * own actions that changed since the last delivered block. Without a baseline
 * it is the full state, sorted and counted the same way.
 */
export class AssignmentSnapshotService {
    options;
    constructor(options) {
        this.options = options;
    }
    async render(context) {
        const reads = new OptionalReads(context.skipUnreadable === true);
        const baseline = this.options.baseline.read(context.sessionId);
        const full = baseline === undefined;
        const owed = owedParts(baseline);
        const sources = await this.readSources(context, reads);
        const now = this.options.nowMs();
        const tasks = this.tasks(context, sources, baseline, owed);
        const ledger = this.ledger(baseline, owed, reads);
        const spaceReadStartedAt = performance.now();
        const contexts = this.contexts(sources.spaceList, baseline, reads);
        const spaceReadMs = Math.round(performance.now() - spaceReadStartedAt);
        const parts = {
            full,
            owed,
            tasks,
            ledger,
            contexts,
            ui: this.ui(baseline, sources.names, now, reads),
            precheck: this.precheck(context, reads),
            overview: await this.overview(sources, full || owed.has('overview'), now, reads),
        };
        const mode = full ? 'full' : 'delta';
        return {
            content: [
                renderWakeLine(context.wakeReasons),
                mcodeStateBlock(mode, bodyLines(parts, sources, now, reads)),
            ].join('\n'),
            mode,
            updates: blockUpdates(parts, reads.skip),
            ...partCounts(parts),
            ...viewFacts(sources.view),
            spaceReadMs,
            ...precheckTrace(parts.precheck),
            owed,
            skipped: reads.skipped(),
        };
    }
    async readSources(context, reads) {
        const [view, previous, spaces] = await Promise.all([
            reads.read('task_view', () => this.options.view.read()),
            reads.read('previous_turn_start', () => this.options.previousTurnStartedAt(context.sessionId, context.turnId)),
            reads.read('space_list', () => this.options.worklines.list()),
        ]);
        const spaceList = spaces.ok ? spaces.value : [];
        return {
            view,
            previousStart: previous.ok ? previous.value : undefined,
            spaces,
            spaceList,
            names: new Map(spaceList.map((item) => [item.id, item.name])),
        };
    }
    /** The task section; undefined when the task view could not be read. */
    tasks(context, sources, baseline, owed) {
        if (!sources.view.ok)
            return undefined;
        const view = sources.view.value;
        return renderTaskDelta({
            tasks: view.tasks,
            // Tasks a full block could not list are listed as a full block would (spec 7.2).
            baseline: owed.has('tasks') ? undefined : baseline,
            sessionId: context.sessionId,
            explained: explainedTasks(context.origin),
            ...(view.partial ? { partial: true } : {}),
            ...(sources.previousStart === undefined
                ? {}
                : { previousTurnStartedAt: sources.previousStart }),
            render: (task, label) => renderTask(task, label, sources.names),
        });
    }
    /** The user's context.md edits; Bunny's own writes are absorbed when made (spec 9.2). */
    contexts(spaces, baseline, reads) {
        const readContext = this.options.worklines.readContext;
        if (!readContext)
            return { lines: [], updates: new Map() };
        const delta = renderContextDelta({ spaces, read: (id) => readContext(id), baseline, safe });
        if (delta.unreadable.length > 0) {
            const named = delta.unreadable.map((item) => `${safe(item.name)}（${safe(item.id)}）`);
            reads.leave('space_context', named.length, named.join('、'));
        }
        return delta;
    }
    /** The ledger's lines and baseline entries; undefined when it could not be read. */
    ledger(baseline, owed, reads) {
        const render = this.options.ledger;
        if (!render)
            return { lines: [], updates: new Map() };
        // A ledger a full block could not carry is carried whole (spec 7.2).
        const delivered = baseline && !owed.has('ledger') ? ledgerDelivered(baseline) : undefined;
        const result = reads.readSync('ledger', () => render(delivered));
        if (!result.ok)
            return undefined;
        const updates = new Map();
        for (const [id, key] of result.value.delivered)
            updates.set(`${LEDGER_KEY}${id}`, key);
        return { lines: result.value.lines, updates };
    }
    /** Full state, or only a change of the space the panel shows (spec 9.2). */
    ui(baseline, names, now, reads) {
        const read = reads.readSync('ui_view', () => this.options.viewState?.());
        if (!read.ok)
            return { lines: reads.lines('ui_view'), updates: new Map() };
        const view = read.value;
        const space = view?.panelOpen ? (view.spaceId ?? 'all') : 'closed';
        const changed = baseline === undefined || baseline.get(UI_SPACE_KEY) !== space;
        return {
            lines: changed ? [renderView(view, names, now)] : [],
            updates: new Map([[UI_SPACE_KEY, space]]),
        };
    }
    /** Pointers help, but a failed lookup never holds up the Turn. */
    precheck(context, reads) {
        const precheck = this.options.precheck;
        if (!precheck || !context.userText.trim())
            return undefined;
        const read = reads.readQuietly('recall_precheck', () => precheck({
            sessionId: context.sessionId,
            userText: context.userText,
            frontContextMessageIds: context.frontContextMessageIds,
            ...(context.currentMessageIds ? { currentMessageIds: context.currentMessageIds } : {}),
        }));
        return read.ok ? read.value : undefined;
    }
    /**
     * Spaces and recent projects: the parts only a full block repeats, and a
     * later block carries while they are owed; undefined otherwise.
     */
    async overview(sources, due, now, reads) {
        if (!due)
            return undefined;
        const { spaces, view } = sources;
        const sessions = await reads.read('overview', () => this.options.sessions.list({ includeSessionKinds: ['conversation'], limit: RECENT_SCAN }));
        if (!sessions.ok)
            return { lines: reads.lines('overview'), complete: false };
        const recent = recentProjects(sessions.value, this.options.bunnyDir).slice(0, 8);
        return {
            lines: [
                ...(spaces.ok ? spaceLines(spaces.value, view.ok ? view.value.tasks : undefined) : []),
                STATE_SECTIONS.projects,
                ...(recent.length
                    ? recent.map((item) => recentProjectLine(safe(path.basename(item.dir)), safe(item.dir), now - item.at))
                    : [STATE_NONE]),
            ],
            complete: spaces.ok,
        };
    }
}
/** The overview's spaces, with their open tasks when the task view was read. */
function spaceLines(spaces, tasks) {
    return [
        STATE_SECTIONS.spaces,
        ...(spaces.length
            ? spaces.map((item) => spaceOverviewLine({
                name: safe(item.name),
                id: safe(item.id),
                system: item.system,
                goal: item.goal ? safe(item.goal) : '',
                projects: (item.projects ?? []).map((project) => safe(path.basename(project))),
                ...(tasks
                    ? {
                        openTasks: tasks.filter((task) => task.worklineId === item.id && !task.assignment?.completion).length,
                    }
                    : {}),
            }))
            : [STATE_NONE]),
    ];
}
// Newest conversations scanned for 近期项目: a project idle for 500 conversations is not recent.
const RECENT_SCAN = 500;
/** The state lines of a block, in the order Bunny reads them (spec 9.2). */
function bodyLines(parts, sources, now, reads) {
    const allTasks = parts.full || parts.owed.has('tasks');
    return [
        stateTimeLine(now, sources.previousStart),
        ...reads.lines('previous_turn_start'),
        ...parts.ui.lines,
        ...reads.lines('space_list'),
        ...(parts.overview?.lines ?? []),
        ...(parts.tasks
            ? section(STATE_SECTIONS.tasks, parts.tasks.lines, allTasks)
            : reads.lines('task_view')),
        ...(parts.ledger
            ? section(STATE_SECTIONS.ledger, parts.ledger.lines, false)
            : reads.lines('ledger')),
        ...section(STATE_SECTIONS.contexts, parts.contexts.lines, false),
        ...reads.lines('space_context'),
        ...closingLines(parts.precheck, reads, sources.view.ok && sources.view.value.stale),
    ];
}
/** What the block delivers once it and the user message are in history. */
function blockUpdates(parts, skip) {
    return new Map([
        ...(parts.tasks?.updates ?? []),
        ...(parts.ledger?.updates ?? []),
        ...parts.contexts.updates,
        ...parts.ui.updates,
        ...owedUpdates(parts, skip),
    ]);
}
/** Parts a block was due to carry whole: owed while unread, cleared once carried (spec 7.2). */
function owedUpdates(parts, skip) {
    const updates = new Map();
    const settle = (part, due, delivered) => settleOwed(updates, part, { due, delivered, owed: parts.owed.has(part), skip });
    settle('tasks', parts.full || parts.owed.has('tasks'), parts.tasks !== undefined);
    settle('ledger', parts.full || parts.owed.has('ledger'), parts.ledger !== undefined);
    settle('overview', parts.overview !== undefined, parts.overview?.complete === true);
    return updates;
}
function partCounts(parts) {
    return {
        shownTaskCount: parts.tasks?.listed ?? 0,
        undeliveredTaskCount: parts.tasks?.undelivered ?? 0,
        ledgerLineCount: parts.ledger?.lines.length ?? 0,
        spaceLineCount: parts.contexts.lines.length,
    };
}
/** What the block says about the task view; a view that could not be read says nothing. */
function viewFacts(view) {
    if (!view.ok)
        return { openTaskCount: 0, stale: false, asOfMs: 0 };
    return {
        openTaskCount: view.value.tasks.filter((item) => !item.assignment?.completion).length,
        stale: view.value.stale,
        asOfMs: view.value.asOfMs,
    };
}
function section(title, lines, always) {
    if (!lines.length)
        return always ? [title, STATE_NONE] : [];
    return [title, ...lines];
}
function closingLines(precheck, reads, stale) {
    return [
        ...(precheck?.text ? [precheck.text] : []),
        ...reads.lines('recall_precheck'),
        ...(stale ? [STALE_STATE_LINE] : []),
    ];
}
function precheckTrace(precheck) {
    return precheck?.trace === undefined ? {} : { precheck: precheck.trace };
}
function ledgerDelivered(baseline) {
    const delivered = new Map();
    for (const [key, value] of baseline)
        if (key.startsWith(LEDGER_KEY))
            delivered.set(key.slice(LEDGER_KEY.length), value);
    return delivered;
}
/** Tasks the Turn's own event message describes: a report's items. */
function explainedTasks(origin) {
    const ids = new Set();
    const items = field(field(origin, 'assignmentReport'), 'items');
    for (const item of Array.isArray(items) ? items : []) {
        const id = field(item, 'sessionId');
        if (typeof id === 'string' && id)
            ids.add(id);
    }
    return ids;
}
function field(value, key) {
    return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}
function renderView(view, names, now) {
    return panelViewLine(view && {
        reportedAtMs: view.reportedAtMs,
        panelOpen: view.panelOpen,
        ...(view.spaceId ? { spaceName: safe(names.get(view.spaceId) ?? view.spaceId) } : {}),
    }, now);
}
function safe(value) {
    return escapeAssignmentData(value).replace(/[\r\n]+/g, ' ');
}
/**
 * The task lines of a handoff header's state snapshot (spec 12.9): the full
 * state a block without a baseline lists, ordered and capped as 9.3, the rest
 * counted. A stale view says so.
 */
export function renderTaskSnapshot(view, spaceNames) {
    const tasks = renderTaskDelta({
        tasks: view.tasks,
        baseline: undefined,
        sessionId: '',
        explained: new Set(),
        render: (task, label) => renderTask(task, label, spaceNames),
    });
    return [...tasks.lines, ...(view.stale ? [STALE_STATE_LINE] : [])];
}
function renderTask(item, label, names) {
    const assignment = item.assignment;
    let detail = item.waitingDetail ||
        (item.errorMessage && taskErrorReason(item.errorMessage)) ||
        item.stallReason ||
        assignment?.completion?.summary;
    if (item.state === 'stopped' || assignment?.completion?.state === 'cancelled')
        detail = TASK_STOPPED_DETAIL;
    const successor = assignment?.completion?.successorSessionId;
    if (successor)
        detail = taskTakenOverDetail(successor);
    return taskRow(label, [
        item.session.title ?? '',
        names.get(item.worklineId ?? ''),
        item.projectName,
        item.session.sessionId,
        detail,
    ]
        .filter((part) => Boolean(part))
        .map(safe));
}
function recentProjects(sessions, bunnyDir) {
    const projects = new Map();
    const root = bunnyDir ? path.resolve(bunnyDir) : undefined;
    for (const item of sessions) {
        if (!isProjectConversation(item))
            continue;
        const dir = item.runLocation?.parentRepoDir ?? item.workspaceDir;
        if (root && isInside(path.resolve(dir), root))
            continue;
        projects.set(dir, Math.max(projects.get(dir) ?? 0, item.updatedAtMs));
    }
    return [...projects].map(([dir, at]) => ({ dir, at })).sort((a, b) => b.at - a.at);
}
function isProjectConversation(item) {
    return (!item.isDefaultWorkspace &&
        item.agentName !== BUNNY_AGENT_NAME &&
        item.sessionKind === 'conversation');
}
function isInside(dir, root) {
    return dir === root || dir.startsWith(root + path.sep);
}
//# sourceMappingURL=snapshot.service.js.map