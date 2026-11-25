import { defineRuntimeTool, TURN_TERMINATING_TOOL_RESULT_DETAIL, } from '@mavis/agent-core/tools';
import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { buildCreateAssignmentRequest } from './local-mavis-bunny.js';
/**
 * The IM chat of the current turn, as an address the task can keep. Only
 * routing fields are copied: the WeChat context token and the inbound message
 * id stay with the channel. Undefined on desktop turns or an incomplete address.
 * The sender counts as part of the address: the runtime's delivery gate checks a
 * coordinator chat's creator by it, so an address without one could never be
 * answered, and is not kept.
 */
export function assignmentOriginChannel(ctx) {
    const channel = ctx.channelContext;
    if (!channel)
        return undefined;
    const text = (key) => {
        const value = Reflect.get(channel, key);
        return typeof value === 'string' && value.trim() ? value : undefined;
    };
    const platform = text('platform');
    const clientName = text('clientName');
    const chatId = text('chatId');
    const chatType = text('chatType');
    const senderId = text('senderId');
    if (!platform || !clientName || !chatId || !chatType || !senderId)
        return undefined;
    const threadId = text('threadId');
    return {
        platform,
        clientName,
        chatId,
        chatType,
        senderId,
        ...(threadId ? { threadId } : {}),
    };
}
const requiredText = (description) => Type.String({ minLength: 1, description });
/**
 * What `bunny.verdictGate` switches.
 *
 * **Off**, the verdict feature is absent from the tool surface: `assignment_claim_verdict` is not
 * registered at all, and `review_of` carries `REVIEW_OF_DESCRIPTION_OFF`, which describes only
 * attaching the checked task's materials and promises no gate. Nothing the model can read says a
 * verdict exists.
 *
 * **On**, `assignment_claim_verdict` appears with the claim moment in front of its description,
 * and `review_of` gains the trigger rule that says filling it gates the checked task. Each on
 * text is the off string behind a leading rule rather than a rewrite, so turning the switch on can
 * never drop a fact the off text carried.
 *
 * This replaced an earlier rule here — "`..._OFF` is byte for byte what each said before the
 * switch existed, so an off render is identical to the surface without this feature" — which
 * assumed the gate was always on before the switch. `bunny.verdictGate` defaults to off, so that
 * assumption no longer holds: an off render still showed `assignment_claim_verdict` describing
 * "不领就不能结案", while the runtime built no gate and `assignment_summary` closed the task
 * happily. A premise that no longer holds should not keep binding the implementation; leaving the
 * tool out when off states the same thing without saying anything untrue.
 */
const REVIEW_OF_DESCRIPTION_OFF = '只在派核对任务时填：系统自动把那个任务记录里的目标、完成标准、最终回复和交付文件附到本任务的首条消息里，' +
    '你不用手抄这些，只写用户诉求和关注点。不填就是普通任务，首条消息与现在完全一致';
/** When to reach for `review_of` at all, and what filling it costs the checked task. */
const REVIEW_OF_TRIGGER = '这份结果要不要独立核对，你来定：任务交出了用户要拿来看、拿来用的东西——交付文件、代码改动、要发布的文档或页面，' +
    '或者你会拿它的结果向用户下结论、给建议、替他做决定，就派一个核对任务；只是查一个事实、读一处已有记录、纯讨论、' +
    '用户问一句话你答完就结束，或者你一两轮工具调用就能核对完的，不派。不要给每个任务都配一个核对任务，' +
    '判断依据是这份结果错了的代价。填了之后，被核对的那个任务由闸门管住：它的结论要等核对结果回来、' +
    '你用 assignment_claim_verdict 领过才能记。';
const reviewOfProperty = (description) => Type.Optional(Type.Object({
    session_id: requiredText('被核对任务的会话 ID'),
    report_key: Type.Optional(requiredText('被核对的那份回传的 report key；知道时才填')),
}, { description }));
/**
 * The files a new task starts with, as local paths. Left out, the runtime hands the task every
 * file the user attached in this Turn: Bunny sees those files but rarely names them, and a task
 * that only gets a description of a screenshot cannot check it (MCT-202611-RGZGEAHO). An empty
 * list is how Bunny says "none". The runtime registers each path as an asset of the task's own
 * Session, so the task reads its own copy and never the assigner's.
 */
const createAttachmentPaths = Type.Optional(Type.Array(requiredText('要附给任务的本地文件路径'), {
    description: '任务开始时附带的本地文件路径。不传时，系统自动附上用户这一轮随消息发来的全部图片和文件；' +
        '传路径列表就只附这些；传空数组表示一个都不附。任务拿到的是属于它自己的副本，返回里的 attachments 列出实际附上的文件。' +
        '路径必须是本机可读的普通文件；本机 grep/glob 排除的那份清单里的路径会被拒绝——密钥类（.ssh、.aws、.kube、.env 与 .env.*、*.key、*.pem、*.p12、*.pfx、.npmrc、id_rsa 等私钥名）以及版本库元数据目录（.git、.svn、.hg 等）。' +
        '用户在**本轮**自己附上的文件不在此列；更早轮次附上的文件仍按这份清单和上限检查，需要的话请用户重新附一次。' +
        '单次派工最多 64 个文件、单个不超过接收方能登记的上限、合计不超过 256 MiB。除此之外不限制路径范围。',
}));
/**
 * The files the assigner chose to send a task with a follow-up, as local paths. Nothing is
 * added for it: a follow-up mostly moves work along rather than handing over new material.
 */
const attachmentPaths = Type.Optional(Type.Array(requiredText('要附给任务的本地文件路径，本机可读的普通文件'), {
    description: '要随消息附给任务的本地文件路径列表，通常取自用户这一轮发来的附件。' +
        '路径必须是本机可读的普通文件；这条入口只校验可读性，不限制路径范围，也不套用派工那条密钥清单或体积上限' +
        '（它分不清哪些是用户本轮自己附上的文件，套上去会拦掉用户亲手交出来的材料）。' +
        '省略或空数组表示不附任何附件，这是正常情况。任务会拿到这些文件属于它自己的副本。',
}));
const createSchema = Type.Object({
    title: requiredText('任务名：名词短语标签，写到这次交付物这一层，不写成句子或步骤；规则见系统提示 <naming>'),
    content: requiredText('自给自足的目标、原因和材料位置'),
    done_when: Type.Array(requiredText('一条完成标准'), { minItems: 1 }),
    attachments: createAttachmentPaths,
    user_words: requiredText('触发这次派出的用户原话，逐字照抄；定时或回传叫醒时写触发它的定时指令或用户最近一句相关原话。系统把它记进任务记录，写进任务说明和执行提醒'),
    project: Type.Optional(requiredText('优先用 project_list 查到项目后填它的 workspace_dir，不填项目名：项目名可能被用户改过，填名字会匹配不上，撞上别的目录名时还会派到错误的目录。没有 workspace_dir 的默认项目（它没有目录）不能派，请用户先在界面里给它加上目录。也可以填已登记项目或它下面任一现有目录（比如项目下的某个仓库或子目录）的绝对路径，系统就在那个目录执行，不会退回上层；省略时在启动起这个 Runtime 的工作目录里执行（用户在这个仓库里启动，就在仓库里执行），没有工作目录时才用事项目录。接着原任务的改动新开任务时，填原任务工作树的绝对路径。显式填 default 时使用事项目录。匹配不到时返回候选项目')),
    space: Type.Optional(requiredText('这个任务推进的事项 ID，必填。只有填了 takes_over 时可以省略，省略就放进原任务的事项。没有相符的事项时，先用 bunny_task_space_create 新建事项，再派任务')),
    worktree: Type.Optional(Type.Boolean({
        default: false,
        description: '派到 git 项目时是否新建独立工作树。默认 false：不传就在项目目录里直接执行，看到的代码和用户一致。' +
            '只有任务明确要修改项目仓库里已跟踪的产品代码（新增、改写、删除、重命名会进版本库的文件）时才传 true，' +
            '系统在项目的 .worktrees/ 下新建一个独立工作树；用户原话要求开工作树的也传 true。' +
            'project 填的是原任务的工作树时不要传，在里面接着改。' +
            '省略 project 时也会在启动目录的 Git 仓库中创建工作树；事项目录或非 Git 项目不支持，传 true 会报错',
    })),
    agent_name: Type.Optional(requiredText('执行的 Agent；默认 mavis，用户点名某个 Agent 时才填')),
    request_id: Type.Optional(requiredText('重试去重标识')),
    review_of: reviewOfProperty(REVIEW_OF_DESCRIPTION_OFF),
    takes_over: Type.Optional(requiredText('要接手的原任务会话 ID。只能接手你自己派的、还开着的任务（运行中、已停止、出错、等批准或回答都可以；已关闭、已取消或已被接手的不行）。已关闭的任务要接着做，直接用 assignment_send 续派，不用接手。' +
        '原任务执行中报错、临时故障后没法接着做，或对话已过长需要换新任务继续时用它，不要先 assignment_cancel。结果不对要返工时，用 assignment_send 发回原任务。' +
        '原任务先停下并关闭为“被接手”，新任务再开始；不填 space 时放进原任务的事项。原任务做到哪、留下的文件要写进新任务说明')),
});
/**
 * `createSchema` with the trigger rule in front of `review_of` (`bunny.verdictGate: true`).
 *
 * Built by overriding one property of the off schema rather than by a second literal, so the two
 * cannot drift: every other property, and the property order, is the off schema's own.
 */
const createSchemaWithReviewTrigger = Type.Object({
    ...createSchema.properties,
    review_of: reviewOfProperty(REVIEW_OF_TRIGGER + REVIEW_OF_DESCRIPTION_OFF),
});
const SEND_REASONS = ['rework', 'supplement', 'decision'];
const sendSchema = Type.Object({
    session_id: requiredText('任务会话 ID'),
    content: requiredText('补充或返工要求'),
    attachments: attachmentPaths,
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
const claimVerdictSchema = Type.Object({
    session_id: requiredText('被核对任务的会话 ID，就是 verdict 提示里 <verdict-notice task="..."> 的那个值'),
});
/**
 * Takes a stored review verdict into this Turn. Named in the close gate's refusal too
 * (`verdict-gate.ts` keeps its own copy of the literal, because that package must never
 * depend on this one), so a rename that misses either side fails a test.
 */
export const CLAIM_VERDICT_TOOL_NAME = 'assignment_claim_verdict';
/**
 * What this tool does. Only ever rendered with `CLAIM_VERDICT_TRIGGER` in front of it, because
 * the tool is registered only while the gate is on — every statement below needs a live gate.
 */
const CLAIM_VERDICT_DESCRIPTION = '读操作：把一个被核对任务的核对结论（verdict）读进你这一轮，并记下是你读的。' +
    '只有你派过核对子任务、且核对结论已经存下的任务能领；结论还没存下、任务没被闸门管住、或任务已结案都会报错。' +
    '领取不等于认同：它只证明你读过这份结论，之后仍然由你决定用 assignment_summary 结案还是 assignment_send 返工。' +
    '不领就不能结案——assignment_summary 会以 ASSIGNMENT_VERDICT_REQUIRED 拒绝你，并让你先调这个工具。' +
    '同一份结论被新一版替换后，旧的领取自动失效，要重新领。返回这份结论的 outcome、summary 和 evidence。仅 Bunny 可调用。';
/** When to reach for this tool, which the off description states the rule of but not the moment. */
const CLAIM_VERDICT_TRIGGER = '<verdict-notice> 唤醒你时，先读结论和它引用的证据，再调这个工具把结论领进这一轮；' +
    '领到之后才能用 assignment_summary 结案，不认同就用 assignment_send 发回原任务返工。';
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
const SEND_TO_USER_DESCRIPTION = '这是你和用户说话的唯一方式：用户只看得到这里发出的内容，你不调工具直接写的文字用户看不到。什么时候发、哪一条带 end_turn，见系统提示的 <turn>；怎么写，见 <voice>。';
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
    const verdictGate = deps.verdictGate === true;
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
            schema: verdictGate ? createSchemaWithReviewTrigger : createSchema,
            description: '调度一个任务：在选定的位置创建会话，并发送首条要求。每个任务都放进一个事项（space）。系统会附上事项信息和执行约定，任务结束或出错后把结果回传给你。返回会话 ID、所属事项、执行位置，以及是否排队；只有返回里带会话 ID 才算派出去了，没看到返回就说没派成。所有事项合计最多 20 个任务同时执行（按用户计，不按事项分别计），多出的排队；等用户批准或回答、出错、已停止、跑完待核对的任务不占名额。仅 Bunny 可调用。',
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
                const originChannel = assignmentOriginChannel(ctx);
                return adapter.createAssignment({
                    ...buildCreateAssignmentRequest({
                        callerSessionId,
                        ...(ctx.turnId ? { callerTurnId: ctx.turnId } : {}),
                        title: input.title.trim(),
                        content: input.content.trim(),
                        userWords: input.user_words.trim(),
                        doneWhen: input.done_when.map((item) => item.trim()),
                        // An empty list is passed on: it is how Bunny asks for no attachments at all.
                        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
                        project: input.project,
                        agent: input.agent_name ?? 'mavis',
                        space: input.space,
                        worktree: input.worktree,
                        requestId: input.request_id,
                        ...(reviewOf ? { reviewOf } : {}),
                        ...(originChannel ? { originChannel } : {}),
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
            description: '给 Bunny 的任务发送补充、后续推进或返工要求。默认合入当前执行：任务正在运行时并入这一轮（mode=steered），空闲、已停止或已关闭（含核对后结案、用户完成、用户标记完成）时开始新一轮（mode=activated）并继续回传；next_turn=true 时排到下一轮（mode=queued）。只有已取消或已被接手的任务不能续派。补充不等于批准，权限请求仍由用户在问卷里决定。仅 Bunny 可调用。',
            execute: (ctx, input, signal) => run('assignment_send', async () => {
                const callerSessionId = await requireBunny(ctx);
                if (!input.session_id.trim() || !input.content.trim())
                    throw new Error('session_id and content must not be empty');
                if (!SEND_REASONS.includes(input.reason))
                    throw new Error('reason must be one of rework, supplement, decision');
                // An IM turn moves the task's replies to this chat; a desktop turn leaves them where they were.
                const originChannel = assignmentOriginChannel(ctx);
                return adapter.sendSession({
                    callerSessionId,
                    callerTurnId: ctx.turnId,
                    sessionId: input.session_id,
                    content: input.content.trim(),
                    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
                    reason: input.reason,
                    // A follow-up for the same task belongs to the work in progress; queueing it
                    // behind the running turn made the task finish without seeing it.
                    ...(input.next_turn === true ? { forceQueue: true } : {}),
                    ...(originChannel ? { originChannel } : {}),
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
        // Registered only while the gate is on. With it off there is no review link to claim and no
        // gate to satisfy, so offering the tool would only let the model call something that errors.
        ...(verdictGate
            ? [
                defineRuntimeTool({
                    name: CLAIM_VERDICT_TOOL_NAME,
                    schema: claimVerdictSchema,
                    description: CLAIM_VERDICT_TRIGGER + CLAIM_VERDICT_DESCRIPTION,
                    execute: (ctx, input) => run(CLAIM_VERDICT_TOOL_NAME, async () => {
                        const callerSessionId = await requireBunny(ctx);
                        if (!input.session_id.trim())
                            throw new Error('session_id must not be empty');
                        if (!adapter.claimAssignmentVerdict)
                            throw new Error('Reading a review verdict is unavailable');
                        return adapter.claimAssignmentVerdict({
                            callerSessionId,
                            sessionId: input.session_id.trim(),
                        });
                    }),
                }),
            ]
            : []),
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