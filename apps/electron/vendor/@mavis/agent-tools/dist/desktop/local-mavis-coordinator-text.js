/**
 * The text of agent-tools only the coordinator (Bunny) reads. Its other runtime text lives in
 * local-runtime-v2's `coordinator-text/`, which depends on this package, never the reverse.
 *
 * Reader: Bunny's main conversation model.
 * Injected: as the error result of a mavis call: a session command its assignment tools
 * replace, or a `space update` that passes a retired field; and, inside a Turn the user woke,
 * as the follow-up after a reply of plain text, which only send_to_user can deliver (the
 * AgentHost asks it and may depend on this package, never on local-runtime-v2's
 * `coordinator-text/`).
 * Cache: the result, or the follow-up message, is written into history.
 */
/** The coordinator dispatches, continues and stops its tasks with its assignment tools, never with mavis. */
export const BUNNY_COMMAND_REPLACEMENTS = {
    'session create': 'Use assignment_create to schedule a task.',
    'session send': 'Use assignment_send to continue or rework a task.',
    'session interrupt': "Use assignment_stop to stop a task's current round; the task stays open. Use assignment_cancel only when the user drops the task.",
};
/**
 * The one line that opens the coordinator's mavis description: it manages its own
 * spaces and reads conversations, and neither the Agent roster nor MCP settings.
 */
export const BUNNY_MAVIS_SUMMARY = "Manage the task-space coordinator's own spaces and read conversations.";
/**
 * Shared commands the coordinator's mavis lists and runs: the read-only session reads
 * that go with its own space, project and task model commands. Everything else in
 * `LOCAL_MAVIS_COMMANDS` is withheld, and `BUNNY_WITHHELD_COMMAND_REPLACEMENTS` says why.
 */
export const BUNNY_SHARED_MAVIS_COMMANDS = [
    'session list',
    'session get',
    'session messages',
];
const AGENT_ROSTER_READ = 'The coordinator does not read the Agent roster: schedule a task with assignment_create when the answer needs it, or ask the user.';
const AGENT_ROSTER_WRITE = "Creating, changing or deleting an Agent is the user's own action: ask the user to do it in the app.";
const MCP_READ = 'The coordinator does not read MCP settings: schedule a task with assignment_create when the answer needs it, or ask the user.';
const MCP_WRITE = "Adding, changing or removing an MCP server is the user's own action: ask the user to do it in the app.";
const SESSION_SETTINGS = "Renaming, archiving or re-modelling a conversation is not the coordinator's: use assignment_cancel to drop a task, and ask the user for anything else.";
const SESSION_HELP = 'There is no session help for the coordinator: its mavis lists its own space, project and task model commands and the read-only session commands.';
/**
 * What the coordinator's mavis answers for a shared command it withholds. The Agent
 * roster, MCP servers and a conversation's own settings are the user's actions; a task's
 * conversation belongs to the assignment tools (`BUNNY_COMMAND_REPLACEMENTS`).
 */
export const BUNNY_WITHHELD_COMMAND_REPLACEMENTS = {
    'agent list': AGENT_ROSTER_READ,
    'agent get': AGENT_ROSTER_READ,
    'agent help': AGENT_ROSTER_READ,
    'agent create': AGENT_ROSTER_WRITE,
    'agent update': AGENT_ROSTER_WRITE,
    'agent delete': AGENT_ROSTER_WRITE,
    'mcp list': MCP_READ,
    'mcp get': MCP_READ,
    'mcp help': MCP_READ,
    'mcp create': MCP_WRITE,
    'mcp update': MCP_WRITE,
    'mcp delete': MCP_WRITE,
    'session update': SESSION_SETTINGS,
    'session help': SESSION_HELP,
};
/** The space memory fields `space update` no longer takes; they live in context.md's `<summary>`. */
export const RETIRED_SPACE_UPDATE_FIELD_ERROR = 'instructions、decisions、next_steps 已取消，请用 space context write 改写 context.md 的 <summary>';
const TURN_ONLY_REMINDER = 'This reminder applies only to the current Turn. Do not save or generalize it.';
/**
 * Asked once when a Turn that took in user input ends with text the user never sees,
 * before the Turn delivered anything through send_to_user.
 */
export const PLAIN_TEXT_ENDING_FOLLOW_UP = [
    '<system-reminder>',
    '你上一条回复是直接写的文字，没有调用 send_to_user，用户看不到，这一轮也还没结束。用户需要看到的内容用 send_to_user 发出，最后一条带 end_turn=true；这一轮还有没做完的事（比如答应过的派任务）就接着做。确实没有要说、也没有要做的，只回复“无”，这一轮就结束，“无”用户也看不到。',
    TURN_ONLY_REMINDER,
    '</system-reminder>',
].join('\n');
/**
 * The same follow-up once the Turn has delivered `delivered` send_to_user messages: the
 * user saw those, so the model sends the plain text whole or, when it only restates
 * them, answers “无”. Telling it the user sees nothing made it send its reply again.
 */
export function plainTextEndingFollowUpAfterDelivery(delivered) {
    return [
        '<system-reminder>',
        `你上一条回复是直接写的文字，没有调用 send_to_user，这段文字用户看不到，这一轮也还没结束。这一轮你已经用 send_to_user 发过 ${delivered} 条，那些用户都看到了。判断刚才这段文字：如果它只是在复述已经发过的内容，也没有要做的，只回复“无”，这一轮就结束，“无”用户也看不到；否则把这段文字用 send_to_user 完整发出，派了什么任务、状态、放在哪、要问用户的问题都不要省略，最后一条带 end_turn=true。这一轮还有没做完的事（比如答应过的派任务）就接着做。`,
        TURN_ONLY_REMINDER,
        '</system-reminder>',
    ].join('\n');
}
/**
 * Asked once when a Turn that took in user input stops with an empty reply (neither text
 * nor tool calls), such as after delivering an opening line and reading reference files.
 */
export function emptyEndingFollowUp(delivered) {
    const body = delivered
        ? `你上一条回复为空且没有调用任何工具，这一轮也还没结束。这一轮你已经用 send_to_user 发过 ${delivered} 条。如果这一轮的事已经全部做完、用户需要的结论也已经发齐了，只回复“无”，这一轮就结束，“无”用户也看不到；如果还有没做完的事（比如刚发了开场白、还没派任务或还没给出结论），请接着完成并用 send_to_user 把结果发给用户，最后一条带 end_turn=true。`
        : '你上一条回复为空且没有调用任何工具，用户什么也没看到，这一轮也还没结束。请继续完成这一轮要做的事并用 send_to_user 回复用户，最后一条带 end_turn=true。确实没有要说、也没有要做的，只回复“无”，这一轮就结束，“无”用户也看不到。';
    return ['<system-reminder>', body, TURN_ONLY_REMINDER, '</system-reminder>'].join('\n');
}
//# sourceMappingURL=local-mavis-coordinator-text.js.map