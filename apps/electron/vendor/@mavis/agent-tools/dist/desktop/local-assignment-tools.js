import { defineRuntimeTool, TURN_TERMINATING_TOOL_RESULT_DETAIL, } from '@mavis/agent-core/tools';
import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { buildCreateAssignmentRequest } from './local-mavis-bunny.js';
const requiredText = (description) => Type.String({ minLength: 1, description });
const createSchema = Type.Object({
    title: requiredText('任务标题'),
    content: requiredText('自给自足的目标、原因和材料位置'),
    done_when: Type.Array(requiredText('一条完成标准'), { minItems: 1 }),
    user_words: requiredText('触发这次派出的用户原话，逐字照抄；定时或回传叫醒时写触发它的定时指令或用户最近一句相关原话。系统把它记进任务记录，写进任务说明和执行提醒'),
    project: Type.Optional(requiredText('项目名，或已登记项目或它下面任一现有目录（比如项目下的某个仓库或子目录）的绝对路径，系统就在那个目录执行，不会退回上层；省略时在启动起这个 Runtime 的工作目录里执行（用户在这个仓库里启动，就在仓库里执行），没有工作目录时才用任务空间的空间目录。接着原任务的改动新开任务时，填原任务工作树的绝对路径。显式填 default 时使用任务空间目录。匹配不到时返回候选项目')),
    space: Type.Optional(requiredText('任务空间 ID；省略时放进 Bunny 的空间')),
    worktree: Type.Optional(Type.Boolean({
        default: false,
        description: '派到 git 项目时是否新建独立工作树。默认 false：不传就在项目目录里直接执行，看到的代码和用户一致。' +
            '只有任务明确要修改项目仓库里已跟踪的产品代码（新增、改写、删除、重命名会进版本库的文件）时才传 true，' +
            '系统在项目的 .worktrees/ 下新建一个独立工作树；用户原话要求开工作树的也传 true。' +
            'project 填的是原任务的工作树时不要传，在里面接着改。' +
            '省略 project 时也会在启动目录的 Git 仓库中创建工作树；空间目录或非 Git 项目不支持，传 true 会报错',
    })),
    agent_name: Type.Optional(requiredText('执行的 Agent；默认 mavis，用户点名某个 Agent 时才填')),
    request_id: Type.Optional(requiredText('重试去重标识')),
    review_of: Type.Optional(Type.Object({
        session_id: requiredText('被核对任务的会话 ID'),
        report_key: Type.Optional(requiredText('被核对的那份回传的 report key；知道时才填')),
    }, {
        description: '只在派核对任务时填：系统自动把那个任务记录里的目标、完成标准、最终回复和交付文件附到本任务的首条消息里，' +
            '你不用手抄这些，只写用户诉求和关注点。不填就是普通任务，首条消息与现在完全一致',
    })),
    takes_over: Type.Optional(requiredText('要接手的原任务会话 ID。只能接手你自己派的、还开着的任务（已停止、出错、运行中、等批准都可以；已取消或已关闭的不行）。' +
        '原任务跑完但结果不对、执行中报错、临时故障后没法接着做，都要重新做这件事时，用它，不要先 assignment_cancel。' +
        '原任务先停下并关闭为“被接手”，新任务再开始，默认放在原任务的空间；原任务做到哪、留下的文件要写进新任务说明')),
});
const SEND_REASONS = ['rework', 'supplement', 'decision'];
const sendSchema = Type.Object({
    session_id: requiredText('任务会话 ID'),
    content: requiredText('补充或返工要求'),
    reason: Type.Union([Type.Literal('rework'), Type.Literal('supplement'), Type.Literal('decision')], {
        description: '这次续派的原因，必填：rework=核对没通过、要求返工；supplement=追加或修改要求、问进展；decision=用户改了决定，通知任务按新决定调整',
    }),
    next_turn: Type.Optional(Type.Boolean({
        description: '只在用户明确要求“等这一轮做完再做”时传 true，消息排到下一轮；默认不传',
    })),
});
const summarySchema = Type.Object({
    items: Type.Array(Type.Object({
        session_id: requiredText('本次结论对应的真实任务会话 ID'),
        summary: requiredText('审查后的结论，记入该任务；不显示在这一轮的回复里'),
    }), { minItems: 1 }),
});
const cancelSchema = Type.Object({
    session_id: requiredText('任务会话 ID'),
    reason: Type.Optional(requiredText('取消原因')),
});
const stopSchema = Type.Object({ session_id: requiredText('任务会话 ID') });
/**
 * `additionalProperties: false` is load-bearing here, unlike the `task` tool that deliberately
 * leaves it off (see `TASK_TOOL_DESCRIPTION`). `send_to_user` is where a model ends its turn, so a
 * second tool call smuggled in as an extra key (`invoke name="run_code"`, MCT-202611-TPXWEI01,
 * MCT-202611-ZVTHNHAF) used to pass validation with the key silently dropped: the model read the
 * success and reported a dispatch that never happened. Rejecting the call makes the model resend
 * it properly instead. Pi's `validateToolArguments` does not strip unknown keys, so the schema
 * alone is enough to turn this into a retryable error.
 */
const sendToUserSchema = Type.Object({
    content: requiredText('发给用户的一段 Markdown。按意思分段，通常一段在 800 字以内。完整的表格、代码或连续步骤可以更长。'),
    quote_question: Type.Optional(Type.Boolean({
        description: '引用当前用户的问题。派工、接手或汇总任务后，任务卡会隔开问题和答复；回到原问题时可设为 true，仅引用一次。紧接问题直接回答时省略。',
    })),
    end_turn: Type.Optional(Type.Boolean({ description: '送达后立即结束这一轮；默认 false' })),
}, { additionalProperties: false });
export const SEND_TO_USER_TOOL_NAME = 'send_to_user';
const SEND_TO_USER_DESCRIPTION = '这是你和用户说话的唯一方式：用户只看得到这里发出的内容，你不调工具直接写的文字用户看不到。什么时候发、发什么、哪一条带 end_turn，见系统提示的 <voice>。';
/**
 * The delivery a send_to_user call would make, or undefined when the call cannot reach
 * the user. Arguments go through the same conversion and the same schema Pi validates
 * before executing the tool, so a call that Pi rejects here is rejected too; blank
 * content never delivers because the tool returns an error for it.
 *
 * Display projection, the preemption notice and the plain-text follow-up all read this
 * one answer. Painting at the Start frame happens before Pi validates, so a call the
 * schema rejects must not paint: the model gets the validation error and resends, and
 * the rejected copy would otherwise stay on screen beside the resent one
 * (MCT-202611-NYQBDYSW).
 */
export function readSendToUserDelivery(args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args))
        return undefined;
    // Pi clones before converting; the caller's object (the model's own arguments) must not
    // change under it. A value that cannot be cloned cannot be validated either.
    let candidate;
    try {
        candidate = structuredClone(args);
    }
    catch {
        return undefined;
    }
    Value.Convert(sendToUserSchema, candidate);
    if (!Value.Check(sendToUserSchema, candidate))
        return undefined;
    const content = candidate.content;
    if (typeof content !== 'string' || !content.trim())
        return undefined;
    return { content, quoteQuestion: candidate.quote_question === true };
}
/**
 * The task model is the user's choice in Bunny settings, never Bunny's: the tool takes no
 * `model`. A stale call that still sends one is not forwarded (MCT-202611-KWIJTTR0).
 */
export function buildLocalAssignmentTools(deps) {
    const adapter = deps.sessionAdapter;
    async function requireBunny(ctx) {
        if (!ctx.sessionId || !isCoordinatorAgent(ctx.coordination))
            throw new Error('Only Bunny sessions can use assignment tools');
        const { session } = await adapter.getSession({ sessionId: ctx.sessionId });
        if (session?.agentName !== 'bunny' || session.archived)
            throw new Error('Only active Bunny sessions can use assignment tools');
        return ctx.sessionId;
    }
    return [
        defineRuntimeTool({
            name: 'assignment_create',
            schema: createSchema,
            description: '调度一个任务：在选定的位置创建会话，并发送首条要求。系统会附上任务空间信息和执行约定，任务结束或出错后把结果回传给你。返回会话 ID、任务空间、执行位置，以及是否排队；只有返回里带会话 ID 才算派出去了，没看到返回就说没派成。所有任务空间合计最多 20 个任务同时执行（按用户计，不按空间分别计），多出的排队；等用户批准或回答、出错、已停止、跑完待核对的任务不占名额。仅 Bunny 可调用。',
            execute: (ctx, input, signal) => run('assignment_create', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!input.title.trim() ||
                    !input.content.trim() ||
                    !input.user_words?.trim() ||
                    !input.done_when.length ||
                    input.done_when.some((item) => !item.trim()))
                    throw new Error('title, content, user_words and done_when must not be empty');
                if (!adapter.createAssignment)
                    throw new Error('Assignment creation is unavailable');
                const takesOver = input.takes_over?.trim();
                const reviewSessionId = input.review_of?.session_id.trim();
                const reviewReportKey = input.review_of?.report_key?.trim();
                const reviewOf = reviewSessionId
                    ? {
                        sessionId: reviewSessionId,
                        ...(reviewReportKey ? { reportKey: reviewReportKey } : {}),
                    }
                    : undefined;
                return adapter.createAssignment({
                    ...buildCreateAssignmentRequest({
                        callerSessionId,
                        ...(ctx.turnId ? { callerTurnId: ctx.turnId } : {}),
                        title: input.title.trim(),
                        content: input.content.trim(),
                        userWords: input.user_words.trim(),
                        doneWhen: input.done_when.map((item) => item.trim()),
                        project: input.project,
                        agent: input.agent_name ?? 'mavis',
                        space: input.space,
                        worktree: input.worktree,
                        requestId: input.request_id,
                        ...(reviewOf ? { reviewOf } : {}),
                        reportBack: true,
                    }),
                    ...(takesOver ? { takesOver } : {}),
                }, signal);
            }),
        }),
        defineRuntimeTool({
            name: 'assignment_send',
            schema: sendSchema,
            // Bounded observability vocabulary: splits rework / supplement / decision
            // in pi_tool_operation_result_* without new label keys.
            operationClassifier: {
                allowedValues: SEND_REASONS,
                classify: (args) => args &&
                    typeof args === 'object' &&
                    typeof args.reason === 'string'
                    ? args.reason
                    : undefined,
            },
            description: '给 Bunny 的任务发送补充或返工要求。默认合入当前执行：任务正在运行时并入这一轮（mode=steered），空闲、已结束或已停止时开始新一轮（mode=activated）并继续回传；next_turn=true 时排到下一轮（mode=queued）。已取消的任务不能续派。补充不等于批准，权限请求仍由用户在问卷里决定。仅 Bunny 可调用。',
            execute: (ctx, input, signal) => run('assignment_send', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!input.session_id.trim() || !input.content.trim())
                    throw new Error('session_id and content must not be empty');
                if (!SEND_REASONS.includes(input.reason))
                    throw new Error('reason must be one of rework, supplement, decision');
                return adapter.sendSession({
                    callerSessionId,
                    callerTurnId: ctx.turnId,
                    sessionId: input.session_id,
                    content: input.content.trim(),
                    reason: input.reason,
                    // A follow-up for the same task belongs to the work in progress; queueing it
                    // behind the running turn made the task finish without seeing it.
                    ...(input.next_turn === true ? { forceQueue: true } : {}),
                    reportBack: true,
                }, signal);
            }),
        }),
        defineRuntimeTool({
            name: 'assignment_summary',
            schema: summarySchema,
            description: '写操作：按 session_id 提交各任务的结论。此工具不发送会话消息；对正在核对的任务提交结论即视为核对通过，任务会立即标记完成，不能撤回。核对完任务结果、确认它达到了你写的完成标准之后，才用它记下结论，供任务面板、之后的任务状态和对话检索使用。提交错的后果：任务被立刻标成已完成、从“等 Bunny 核对”里消失，用户以为这件事已经收口，没做完的部分不会再有人接手；不提交的后果：任务在用户界面上不会变成已完成，会一直停在“等 Bunny 核对”，用户只能盯着它等，被中断的任务也一样，不提交结论就没有人收口。仅 Bunny 可调用。',
            execute: (ctx, input) => run('assignment_summary', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!adapter.summarizeAssignments)
                    throw new Error('Task summaries are unavailable');
                return adapter.summarizeAssignments({
                    callerSessionId,
                    items: input.items.map((item) => ({
                        sessionId: item.session_id,
                        summary: item.summary,
                    })),
                });
            }),
        }),
        defineRuntimeTool({
            name: 'assignment_cancel',
            schema: cancelSchema,
            description: '取消 Bunny 的任务：打断正在运行的那一轮，任务关闭为“已取消”，之后不能再续派。返回更新后的任务状态。仅 Bunny 可调用。',
            execute: (ctx, input) => run('assignment_cancel', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!input.session_id.trim())
                    throw new Error('session_id must not be empty');
                if (!adapter.cancelAssignment)
                    throw new Error('Assignment cancellation is unavailable');
                return adapter.cancelAssignment({
                    callerSessionId,
                    sessionId: input.session_id,
                    reason: input.reason,
                });
            }),
        }),
        defineRuntimeTool({
            name: 'assignment_stop',
            schema: stopSchema,
            description: '停下 Bunny 的一个任务正在执行的这一轮。任务不关闭，显示“已停止”，等用户决定续派、标记完成或取消；这一轮不回传，也不会自动续派。只能停 Bunny 自己派的任务。返回更新后的任务状态。仅 Bunny 可调用。',
            execute: (ctx, input) => run('assignment_stop', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!input.session_id.trim())
                    throw new Error('session_id must not be empty');
                if (!adapter.stopAssignment)
                    throw new Error('Stopping a task is unavailable');
                return adapter.stopAssignment({ callerSessionId, sessionId: input.session_id });
            }),
        }),
        defineRuntimeTool({
            name: SEND_TO_USER_TOOL_NAME,
            schema: sendToUserSchema,
            description: SEND_TO_USER_DESCRIPTION,
            execute: async (_ctx, input) => sendToUser(input),
        }),
    ];
}
function sendToUser(input) {
    const content = typeof input.content === 'string' ? input.content : '';
    if (!content.trim()) {
        const text = JSON.stringify({ delivered: false, error: 'content must not be empty' });
        return {
            tool_name: SEND_TO_USER_TOOL_NAME,
            text,
            content: [{ type: 'text', text }],
            isError: true,
        };
    }
    const text = JSON.stringify({ delivered: true });
    const result = {
        tool_name: SEND_TO_USER_TOOL_NAME,
        text,
        content: [{ type: 'text', text }],
        details: { [SEND_TO_USER_TOOL_NAME]: { content } },
    };
    if (input.end_turn !== true)
        return result;
    // Same marker as the goal module's endTurn(): `terminate` is consumed by the agent loop,
    // while the detail survives in canonical history so continuation sees a deliberate end.
    return {
        ...result,
        details: { ...result.details, [TURN_TERMINATING_TOOL_RESULT_DETAIL]: true },
        terminate: true,
    };
}
async function run(name, action) {
    try {
        const text = JSON.stringify({ ok: true, result: await action() });
        return { tool_name: name, text, content: [{ type: 'text', text }] };
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : 'ASSIGNMENT_ERROR';
        const candidates = error instanceof Error && 'candidates' in error ? error.candidates : undefined;
        const text = JSON.stringify({
            ok: false,
            error: {
                code,
                message: error instanceof Error ? error.message : String(error),
                ...(candidates ? { candidates } : {}),
            },
        });
        return { tool_name: name, text, content: [{ type: 'text', text }], isError: true };
    }
}
//# sourceMappingURL=local-assignment-tools.js.map