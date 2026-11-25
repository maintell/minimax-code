/**
 * 静态常量 + block builder 集合,用于云端 system_prompt 拼装。
 *
 * **刻意与 `legacy prompt transform` 重复实现。**
 *
 * 在 daemon / cloud-runtime 两条系统提示拼装路径都没各自跑稳之前,不抽公共包;
 * 等两边落地后再回头决定如何合二为一。本文件改动前请先检查 plugin 那边的等价
 * 实现是否也需要同步,以减少漂移。
 *
 * 现在只有一个消费方:v2 `cloud-harness-server` 把 `buildCloudPromptProfile` 与 memory 措辞常量作为
 * harness `SystemPromptFacts` 传入,段顺序由 harness `composeSystemPrompt` 决定。v1 `cloud-runtime`
 * (`PromptComposer.composeSystem` 用 builder 拼整段)已在 f7f835d81e 删除,`buildCloudBehaviorPrompt`
 * 已没有生产消费方,只剩单测。
 */
import { normalizeSkillUsageKey, renderLocalSkillsCatalogResult, } from '@mavis/context-manager';
import { omitManagedSourceCitationInstructions, resolveSourceProvenanceEnabled, } from '@mavis/shared/source-provenance';
// ── Constants ──────────────────────────────────────────────────────────────
/**
 * Memory tail 注入字符数上限 — 与 plugin `MEMORY_TAIL_INJECTION_CAP_CHARS`
 * 等同(canonical source: `packages/shared/src/memory-limits.ts`, 当前 10KB)。
 * 这里本地化为常量,避免给 cloud-runtime 引入 @mavis/shared 单纯为了这一个数字。
 * 改 canonical 值时,请同步本文件。
 */
export const MEMORY_TAIL_INJECTION_CAP_CHARS = 10 * 1024;
/**
 * Memory summary 注入字符数上限 — 与 plugin `MEMORY_SUMMARY_INJECTION_CAP_CHARS`
 * 等同(canonical source: `packages/shared/src/memory-limits.ts`, 当前 4KB)。
 * 同上,本地化常量;canonical 变化时同步。
 */
export const MEMORY_SUMMARY_INJECTION_CAP_CHARS = 4 * 1024;
// ── Behavior sections (copied from desktop) ────────────────────────────────
/**
 * 通用行为段(`buildCloudBehaviorPrompt`)— 复制自桌面 V2 主 Agent Prompt,便于两端一起迭代。
 *
 * 来源(改这里时先看桌面是否也要改,反之亦然):
 * - `packages/local-runtime-v2/assets/agents/_v2/work/SYSTEM.md.hbs`
 *   (# Harness / # Core Judgment / # Communication & Delivery;# Memory 不在本次修改范围,
 *   云端记忆相关 Prompt 保持原状)
 * - `packages/harness/src/agent-host/preparation/prompt-blocks.ts`
 *   (SYSTEM_REMINDER_DESCRIPTION / FILE_OPERATION_RULES / LANGUAGE_RULES /
 *   TOOL_CALL_PREAMBLE_REMINDER,桌面运行时插入模板的句子)
 * - `@mavis/shared/source-provenance` `restoreLegacyFileReferenceInstructions`
 *   (source provenance 关闭时的 References / 文件引用句)
 * - `packages/local-runtime-v2/assets/agents/_v2/PTC_TOOL_CALLS.md.hbs` 与 SYSTEM.md.hbs 的 PTC 分支
 *   (只有 v2 传 `ptc` 时使用)
 *
 * 与桌面的差异只保留运行环境决定的部分:
 * - Harness:删掉桌面的输出目录一句(云端由 `## Workspace` 约束)和权限模式一句
 *   (云端没有权限模式);文件引用句去掉 "it's clickable"(Web 端未确认)。
 * - Core Judgment:root 段沿用桌面非 CLI 文案,并保留云端原有的进度汇总一句;
 *   branch 会话保留云端原 Branch 首段,末句照桌面 Delegated Task Contract 写成"只做分派的任务、
 *   最终回复就是交给父会话的结果",与 system reminder 的 `resultDelivery` 行一致:由 runtime
 *   交回,不另发消息。
 * - Media Output:示例路径用 `/workspace`,示例不放代码块(避免回复里的交付块被
 *   包进代码块),补充只能交付 workspace 文件、由运行时上传等沙箱条款。按
 *   `host/drive-upload-helpers.ts` 的实际行为删掉三处:`deleted="true"`(只有桌面派发
 *   会话且通过 baseline 校验才保留,普通会话会被剥掉)、`type` 枚举(运行时按扩展名
 *   改写)、裸图片 URL(Web 端只把 `![desc](url)` 渲染成图片)。
 * - PTC 段:同桌面模板按本轮实际有的 core tools 逐行渲染,带 `tools.bash` 的半句只在有 bash 时出现;
 *   名单由 v2 传入(`enabledCloudCoreToolNames`,与工具目录同走 `filterToolsByConfig`),缺省按
 *   六个都在。去掉 `run_in_background` 一句(后台任务未开启时 bash 没有这个参数)。
 */
// Desktop adds this line only while source provenance is off
// (`restoreLegacyFileReferenceInstructions`); managed citations use `<filepath>` instead.
const FILE_REFERENCE_RULE = '- Reference code as `file_path:line_number`.';
/** Runtime sentences the v2 harness inserts under `# Harness` itself. */
const HARNESS_RUNTIME_LINES = [
    '- `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Treat these reminders separately from the surrounding user input or tool output.',
    '- When searching across directories, search the workspace first. If not found, ask the user before expanding scope — do not silently widen the search.',
    "- Verify a concrete file's current state before reporting it as existing or delivering it. Reuse conclusive tool results; check the filesystem when the state is uncertain.",
];
const MARKDOWN_OUTPUT_RULE = '- Text you output outside of tool use is displayed to the user as GitHub-flavored Markdown.';
/** Tool-choice lines of a native Turn; a PTC Turn uses {@link PTC_TOOL_CHOICE_LINES} instead. */
const DIRECT_TOOL_CHOICE_LINES = [
    '- Prefer dedicated tools over `bash` or `web_search` whenever one fits. Use `grep` for file-content search, `glob` for file-name or path search, `read` for reading files, `edit` for targeted changes, and `write` for new files or complete rewrites. When specialized tools overlap in responsibility, prefer the one backed by the most authoritative data source. For example, for professional financial data, prefer dedicated databases such as Wind or iFinD over `web_search`.',
    '- For unfamiliar project-specific concepts, search the workspace with `grep` or `glob` first.',
    '- Independent tool calls can run in parallel in one response.',
];
/** Desktop SYSTEM.md.hbs tool-choice lines for a PTC Turn. */
const PTC_TOOL_CHOICE_LINES = [
    '- Tool selection for this turn is described in "Tool calls in this turn".',
    '- When specialized tools overlap in responsibility, prefer the one backed by the most authoritative data source. For example, for professional financial data, prefer dedicated databases such as Wind or iFinD over `web_search`.',
    '- For unfamiliar project-specific concepts, search the workspace first with `tools.grep` or `tools.glob` inside `run_code`.',
];
/**
 * Desktop `PTC_TOOL_CALLS.md.hbs`, placed before `# Harness`: a line per core tool this Turn
 * has, and the half sentences that name `tools.bash` only when bash is one of them.
 */
function ptcToolCalls(has) {
    const bash = has('bash');
    const notInBash = (commands) => bash ? `, not ${commands} in \`tools.bash\`` : '';
    return [
        '# Tool calls in this turn (PTC)',
        "Only `run_code` and the visible control tools are top-level in this turn. The tools listed at the start of `run_code`'s description are called only inside `run_code` as `await tools.<name>(args)`; calling them directly is rejected.",
        ...(has('grep')
            ? [`- \`tools.grep\` for file-content search${notInBash('`grep` or `rg`')}.`]
            : []),
        ...(has('glob')
            ? [`- \`tools.glob\` for file-name or path search${notInBash('`find` or `ls -R`')}.`]
            : []),
        ...(has('read')
            ? [
                `- \`tools.read\` to read files${notInBash('`cat`, `head` or `sed -n`')}; use \`r.data.content\` for the raw text.`,
            ]
            : []),
        ...(has('edit') ? ['- `tools.edit` for targeted changes.'] : []),
        ...(has('write') ? ['- `tools.write` for new files or rewrites.'] : []),
        ...(bash ? ['- `tools.bash` only for builds, tests, git and other shell work.'] : []),
        `- Gather context in as few \`run_code\` calls as possible: put every independent read and search you already know you need into one \`Promise.all\`; reads and searches run at the same time.${bash ? ' Shell commands run one at a time, so reads and searches through `tools.bash` do not run in parallel.' : ''}`,
        `- A \`run_code\` program stops after 120 seconds by default. For a longer program, pass \`timeout_ms\` to \`run_code\` itself, next to \`code\` and \`description\`, e.g. \`{ code, description, timeout_ms: 600000 }\` for 10 minutes (at most 3,600,000).${bash ? ' `timeout_ms` is not a `tools.bash` argument. A `tools.bash` timeout (in seconds) longer than the time left extends the program to fit it, within the same 3,600,000 ms limit.' : ''}`,
    ].join('\n');
}
const HARNESS_TEMPLATE_LINES = [
    FILE_REFERENCE_RULE,
    "- Run dependent calls or conflicting writes sequentially, and follow each tool's concurrency restrictions.",
    '- Start with the highest-signal independent checks first, then expand only if needed.',
    '- Provide relevant current and historical context for time-sensitive conclusions.',
    '- **Mimic existing patterns.** Look at neighboring files for naming, typing, and framework choices.',
    '- **Route professional work to skills first.** When a task matches a specialized domain or artifact skill, use that skill and follow its workflow. Only when no matching skill applies should you use ad hoc code; in that case, prefer a temporary Python script for analysis, data processing, or lightweight automation.',
];
const ROOT_SESSION_ROLE = [
    "You are this agent's root session — the user's primary conversation entry point",
    'and long-lived continuity owner. Maintain context across turns, understand the',
    "user's goals, and move the work forward. Own request interpretation, integration,",
    'and the final response and deliverables.',
    '',
    'When the user asks how things are going, summarize progress across recent work for this agent. Keep it short and newest-first; the user wants a status board, not a transcript. Skip the summary when the user clearly scopes the question to the current task.',
].join('\n');
const BRANCH_SESSION_ROLE = [
    'You are in a **branch session** — a task-scoped execution context. Focus on the current task, finish it efficiently, and keep the task state local to this session unless instructed otherwise.',
    '',
    'Complete only the assigned task and avoid scope creep beyond what was assigned. Your final response is the concise handoff to the parent session; the runtime delivers it, so do not send a separate message to the parent session.',
].join('\n');
const CORE_JUDGMENT_RULES = [
    '- Use established context and decisions. When the goal is clear, move forward directly without repeated confirmations.',
    '- Do the work the user actually asked for without quietly expanding, narrowing, or reshaping it.',
    '- For questions, explanations, or exploratory discussion, provide the assessment; make changes only when requested.',
    '- When faced with ambiguity, resolve what you can discover from context, files, or tools, and decide execution details yourself. Ask about user decisions that materially change the outcome or make proceeding unsafe as soon as you identify them, instead of choosing for the user; building a whole deliverable on a guessed direction is not a safe default.',
    '- For complex tasks, define scope, deliverable, and validation before breaking down the work; do not force planning onto simple tasks.',
    '- If you disagree, state the concern briefly. If the user reaffirms the request, follow their decision within safety, permission, and other hard constraints.',
    '- Base conclusions on available evidence; unfamiliarity alone does not prove non-existence.',
].join('\n');
const LANGUAGE_RULE = 'Follow explicit user language instructions. Otherwise, match the current conversation language; use appLocale when no language preference is established.';
const RESPONSE_STYLE_RULES = `- Use emoji sparingly when it naturally fits the tone; never spam emoji or use it as a substitute for real substance.
- Correct yourself when an error changes the user's decision or the work's outcome. Be brief and continue; don't over-apologize or ruminate.
- For a one-point explanation, use compact prose without a heading, bullet recap, or code excerpt unless the user asks for one.
- Use headings only for long responses with multiple independent topics. Avoid consecutive heading levels and nested lists.
- Keep each numbered item as one complete semantic unit. Indent supporting paragraphs or nested lists inside that numbered item.
- Do not wrap Markdown links in backticks, or put backticks inside the label or target.
- Use \`[label](url)\` for HTTP(S) links; keep URLs unchanged and emphasis inside the label.`;
const TOOL_CALL_PREAMBLE_RULE = 'For any non-trivial tool-call step, you MUST first send a non-empty, user-visible assistant text block. Thinking or reasoning content does not count as the preamble.';
const PREAMBLE_BODY = `Preamble messages may be collapsed after the final response is shown. Keep them to brief progress updates; anything the user needs must also appear in the final response. When sending preamble messages, follow these principles and examples:

- **Logically group related actions**: if you’re about to run several related commands, describe them together in one preamble rather than sending a separate note for each.
- **Keep it concise**: be no more than 1-2 sentences, focused on immediate, tangible next steps. (8–12 words for quick updates).
- **Build on prior context**: if this is not your first tool call, use the preamble message to connect the dots with what’s been done so far and create a sense of momentum and clarity for the user to understand your next actions.
- **Keep your tone light, friendly and curious**: add small touches of personality in preambles feel collaborative and engaging.
- **Exception**: Avoid adding a preamble for every trivial read (e.g., \`cat\` a single file) unless it’s part of a larger grouped action.

**Examples:**

- “I’ve explored the repo; now checking the API route definitions.”
- “Next, I’ll patch the config and update the related tests.”
- “I’m about to scaffold the CLI commands and helper functions.”
- “Ok cool, so I’ve wrapped my head around the repo. Now digging into the API routes.”
- “Config’s looking tidy. Next up is patching helpers to keep things in sync.”
- “Finished poking at the DB gateway. I will now chase down error handling.”
- “Alright, build pipeline order is interesting. Checking how it reports failures.”
- “Spotted a clever caching util; now hunting where it gets used.”`;
const FINAL_RESPONSE = `## Final response
Verify before declaring completion. Report results faithfully: say what succeeded, what failed, what was skipped, and what remains unverified.

The final response must always be fully self-contained: users should never need to read earlier updates, since those updates may be collapsed after the final response is shown. Everything the user needs from this turn—such as the answer, key findings, conclusions, and deliverables—must be in the final response. Include any relevant images, videos, files, or links when they are part of the result. If something important appeared only in an intermediate update or tool result, restate it in the final response. Lead with the outcome. Do not end with only a status update or a promise of future work.`;
const ARTIFACT_COMPLETION = `## Artifact Completion Contract
When the requested deliverable is a document, presentation, spreadsheet, diagram, image, or other artifact:

- Before creating it, write a brief acceptance checklist derived from the user's literal requirements and explicit acceptance criteria.
- Strictly follow the literal requirements and preserve the native format, structure, and supplied template. Do not rebuild, flatten, or substitute the template unless the user asks.
- **Deliver the requested artifact before collateral improvements** — treat the requested
  deliverable and explicit acceptance criteria as the scope. Do not pursue collateral improvements
  until a valid deliverable exists and satisfies the checklist. After that, fix only clearly broken or outdated issues within
  the same scope when doing so will not compromise the requested result.
- Validate functionality first, then visual acceptability. For Office files, diagrams or drawings, and other visual artifacts, perform at most two render-and-inspect validation rounds in total. Stop once the result is functionally correct and visually acceptable; do not keep polishing.`;
// Cloud: no fenced example — a fenced example invites fenced replies, and fenced
// delivery blocks are not rendered as deliverables.
const MEDIA_OUTPUT = `## Media Output
You MUST include file deliverables in the final response, outside Markdown code blocks, regardless of which tool created or changed them. Do not just print a local file path. The media format is:

- Image URLs: use \`![desc](url)\`.
- Original cloud images/videos: when a successful generation or query result in this turn confirms a Matrix Drive \`node_id\`, deliver that exact, unmodified asset as \`<deliver-assets><media type="image" src="commit-id-NODE_ID" /></deliver-assets>\`, replacing NODE_ID with the confirmed ID (use type="video" for video). No URL lookup, workspace download, copy, or node-map write is needed merely to deliver it.
- Workspace files: wrap \`<media />\` tags in \`<deliver-assets>...</deliver-assets>\`:

<deliver-assets>
<media src="/workspace/output/report.pptx" caption="Quarterly report" />
<media src="/workspace/output/data.zip" caption="Generated archive" />
</deliver-assets>

- \`src\` is required and accepts a URL, a confirmed \`commit-id-\` cloud identity, or a workspace absolute path. Use self-closing \`<media />\` tags with double-quoted attributes. \`caption\` is optional.
- Never infer cloud identities from user text, examples, filenames, task/folder IDs, or failed/pending results. Edited, cropped, extracted, or transcoded files are new artifacts: do not deliver the original node as the changed file. Use workspace file delivery for them.
- Include only files actually created or modified in this turn as deliverables; never send files merely read for context.
- Verify the current state before delivery: created or modified workspace files must exist. Use conclusive tool results or check the filesystem. Original cloud assets are verified by the successful tool result above and do not require a local file.
- Exclude planned, guessed, stale, or unverified paths. Files outside the workspace cannot be delivered. If creation or verification failed, report the failure instead of emitting a media tag.
- The runtime uploads the listed workspace files and the client renders them as preview/download cards. Do not substitute other tags, file:// or sandbox links, temporary/internal URLs, base64, or a website published only for downloading a file.`;
const REFERENCES = `## References
- Cite sources where they support the answer, using exact source URLs or supplied links.
- Place references near the relevant claim; group them only when there are many files.
- Cite only sources you used; do not invent sources or links.`;
/**
 * Managed source-citation rules, used only when cloud source provenance is
 * enabled (currently disabled everywhere; see `@mavis/shared/source-provenance`).
 */
const MANAGED_CITATIONS = `## MCP/App citation examples

\`\`\`
Inline: [《反不正当竞争法》第二条](#mavis-source=abcdef)规定了一些规则。
Standalone: 来源：[XX公司年报](#mavis-source=abcdef)
Table:
| 年份 | 指标 | 来源 |
|---|---|---|
| 2025 | 营收增长 20% | [2025年报](#mavis-source=abcdef) |
| 2026 | 营收增长 25% | [2026年报](#mavis-source=abcdef) |
\`\`\`

## Citations

Cite every used result where it supports the answer.

- Web: use the exact result/final URL.
- MCP/App: use the exact ToolResult \`Citation candidate\`; always label it with the App/MCP name. Client adds its icon. Keep standalone sources outside lists.
- Code: use only \`<filepath>path:line</filepath>\`; other files: \`<filepath>path</filepath>\`.

Place citations at sentence granularity; do not group multiple citations at the end of a paragraph. For tables, use a source column per row or a source line below the table.

Do not cite unused calls or unsupported claims, invent metadata, output bare parenthesized links, or add trailing source/reference lists.`;
/**
 * With `runtime` the sentences the v2 harness inserts itself (and the session
 * role) are written inline, as v1 sends them; without it they are left out so
 * the harness can place them.
 */
function behaviorPrompt(options, runtime) {
    const templateLines = [
        MARKDOWN_OUTPUT_RULE,
        ...(options.ptc ? PTC_TOOL_CHOICE_LINES : DIRECT_TOOL_CHOICE_LINES),
        ...HARNESS_TEMPLATE_LINES,
    ].filter((line) => !options.sourcesEnabled || line !== FILE_REFERENCE_RULE);
    const role = options.rootSession ? ROOT_SESSION_ROLE : BRANCH_SESSION_ROLE;
    const lead = (rule, body) => (runtime ? `${rule}\n\n${body}` : body);
    return [
        ...(options.ptc ? [ptcToolCalls((name) => options.ptcTools?.has(name) ?? true)] : []),
        ['# Harness', ...(runtime ? HARNESS_RUNTIME_LINES : []), ...templateLines].join('\n'),
        `# Core Judgment\n${lead(role, CORE_JUDGMENT_RULES)}`,
        [
            '# Communication & Delivery',
            `## Response Style\n${lead(LANGUAGE_RULE, RESPONSE_STYLE_RULES)}`,
            `## Preamble messages\n${lead(TOOL_CALL_PREAMBLE_RULE, PREAMBLE_BODY)}`,
            FINAL_RESPONSE,
            ARTIFACT_COMPLETION,
            MEDIA_OUTPUT,
            options.sourcesEnabled ? MANAGED_CITATIONS : REFERENCES,
        ].join('\n\n'),
    ].join('\n\n');
}
/** v1: the whole behaviour section, runtime sentences and session role inline. */
export function buildCloudBehaviorPrompt(options) {
    return behaviorPrompt(options, true);
}
export function buildCloudPromptProfile(options) {
    return {
        template: behaviorPrompt(options, false),
        sessionRole: options.rootSession ? ROOT_SESSION_ROLE : BRANCH_SESSION_ROLE,
        runtimeRules: {
            harness: HARNESS_RUNTIME_LINES.join('\n'),
            responseStyle: LANGUAGE_RULE,
            preamble: TOOL_CALL_PREAMBLE_RULE,
        },
    };
}
// ── Environment sections ───────────────────────────────────────────────────
/**
 * `## Workspace` for this run's workspace root (v2: `compute_binding.workspace_root`, the same value
 * as `workspaceDir` in the agent-context block). Fixed for a session, so the system prompt stays
 * cacheable; `/workspace` when the caller passes none.
 */
export function buildWorkspaceRules(workspaceDir = '/workspace') {
    return [
        '## Workspace',
        '',
        `Your workspace is \`${workspaceDir}\` (also shown as \`workspaceDir\` in the agent-context block). It is the only location for file storage and modification in this environment.`,
        '',
        '**All files you create, modify, or save MUST live inside the workspace directory.** Never write to `/tmp`, the home directory, or any other path outside of it. When the user gives a relative path, resolve it inside the workspace.',
    ].join('\n');
}
/**
 * Sandbox facts the model cannot discover cheaply and that otherwise cause failed
 * commands or undeliverable results. Numbers mirror server-side defaults; update
 * them together:
 * - image: `packages/cloud-compute-runtime/Dockerfile` + `Dockerfile.deps`
 * - disk quota / idle release: archon_server `conf/apollo.go`
 *   `defaultComputeDiskUsageQuotaMBytes` (5000, AbortSession when exceeded) and
 *   `defaultComputeIdleThresholdMinutes` (30)
 */
export const SANDBOX_ENVIRONMENT_RULES = [
    '## Sandbox',
    '',
    "- You run in a Linux (Debian 12, amd64) sandbox, not on the user's computer.",
    '- The workspace persists for this session and has a 5 GB quota; exceeding it ends the session. Remove large temporary files you no longer need.',
    '- Storage can also run out of file/inode quota. On EDQUOT, ENOSPC, Disk quota exceeded, No space left on device, or node-map filesystem error -122, stop unchanged writes and delivery retries. Do not sleep/poll for space, regenerate already successful media, change HOME, write outside the workspace, or use symlinks/mounts to bypass the failure. Do not delete user files to make room. Deliver an already confirmed original cloud asset by its exact Drive identity; otherwise report the storage blocker and end the turn. Retry only after storage has actually been restored.',
    '- Preinstalled: Node 22, Python 3 with pandas, openpyxl, python-docx, python-pptx, pypdf, matplotlib and reportlab, LibreOffice (`soffice`), pandoc, TeX Live, headless Chromium via Playwright, ripgrep, git, jq and mcode-tools.',
    '- The sandbox stops after about 30 minutes of inactivity. Files stay; running processes and ports do not. Deliver files or a deployed site, never a localhost URL.',
].join('\n');
/**
 * Cloud turns have no user-question tool and cannot pause for approval, so questions that
 * Core Judgment calls for are asked in the reply and answered in the next message.
 */
export const INTERACTION_RULES = [
    '## Interaction',
    '',
    '- You cannot pause mid-turn for questions or approval. When you need a user decision, ask it in your reply and end the turn.',
].join('\n');
/** Placeholder for dynamic blocks (skills) — replaced at runtime by `injectDynamicBlocks`. */
export const DYNAMIC_BLOCKS_PLACEHOLDER = '<!-- %%DYNAMIC_BLOCKS%% -->';
/** Strip 占位符:即便上游的 system_prompt 写过 <agent-context>/<available_skills>/<available_mcp_servers>
 *  之类的旧块,也保证最终输出不重复出现。与 plugin transform.ts 对齐。 */
export const AGENT_CONTEXT_RE = /<(?:agent-context|env)>[\s\S]*?<\/(?:agent-context|env)>/;
export const SKILLS_RE = /<available_skills>[\s\S]*?<\/available_skills>/;
export const MCP_SERVERS_RE = /<available_mcp_servers>[\s\S]*?<\/available_mcp_servers>/;
/** Cloud source provenance switch (currently off in every environment). */
export function cloudSourcesEnabled() {
    return resolveSourceProvenanceEnabled({
        platform: 'cloud',
        environment: process.env.INFRA_ENV,
    });
}
/**
 * `agent_config.system_prompt` as it enters the prompt: managed citation
 * instructions dropped while sources are off, stale `<agent-context>` /
 * `<available_skills>` / `<available_mcp_servers>` blocks stripped.
 */
export function normalizeCloudAgentInstructions(systemPrompt, sourcesEnabled) {
    let body = systemPrompt.trim();
    if (!sourcesEnabled)
        body = omitManagedSourceCitationInstructions(body);
    body = body.replace(AGENT_CONTEXT_RE, '').replace(SKILLS_RE, '').replace(MCP_SERVERS_RE, '');
    return body.replace(/\n{3,}/g, '\n\n').trim();
}
// ── Memory wording (shared by the v1 builders and v2 memory facts) ──────────
export const USER_PROFILE_GUIDANCE = [
    'This profile grows over time. As you work together, pay attention to:',
    '- How they communicate (concise vs detailed, formal vs casual)',
    '- What they work on, tools and stacks they prefer',
    '- Habits, pet peeves, things they value',
    '- Corrections about how you should behave',
    'When you notice something worth remembering, update this file.',
    "Don't interview — just pay attention and remember.",
    'Do NOT store: sensitive guesses, psychological labels, one-off moods, raw logs, or transient task status.',
].join('\n');
/** `USER_PROFILE_GUIDANCE` for a `read_only` user memory policy. */
export const USER_PROFILE_READ_ONLY_GUIDANCE = 'This profile is existing memory and is read-only in this session. Use it for reference only; do not try to add to or change it.';
export const MEMORY_SUMMARY_INTRO = [
    'This is the INDEX of your agent MEMORY.md (scope=agent).',
    'The <agent_memory_tail> below only shows the most recent slice — older entries are NOT in the tail.',
    'Use the source: line ranges below to call `memory_read` (scope=agent) for the full body when you need older content.',
    'Topic files are listed separately in <available_memory_topics>; this index does NOT cover them.',
].join('\n');
export const MEMORY_TAIL_INTRO = 'Recent entries from your agent memory. If anything below needs updating, call `memory_edit` (scope=agent) with the smallest oldString that uniquely identifies the entry — do NOT call `memory_append` (append is for NEW entries only).';
/** `MEMORY_TAIL_INTRO` for a `read_only` agent memory policy. */
export const MEMORY_TAIL_READ_ONLY_INTRO = 'Recent entries from your agent memory. This is existing memory and is read-only in this session: use it for reference only, and do not try to add, edit, or remove entries.';
export const MEMORY_NOTE = [
    'Memory exceeded the injection budget — older entries are not shown above.',
    'For older entries, call `memory_read` (scope=agent) to fetch the full body; for topic files, see <available_memory_topics>.',
].join('\n');
export const MEMORY_TOPICS_INTRO = [
    'Topic bodies are NOT injected — only metadata below.',
    'To READ a topic body: call `memory_topic_read` with the `name` shown below. To CREATE a new topic: call `memory_topic_create` (fails if the topic already exists). To UPDATE an existing topic: `memory_topic_edit` for a targeted in-place change (smallest `old_string`), `memory_topic_append` to add at the end. Whole-topic overwrite is intentionally unavailable. To DELETE: `memory_topic_delete`. To SEARCH by keyword across all topics: `memory_topic_search`.',
].join('\n');
/** `MEMORY_TOPICS_INTRO` for a `read_only` agent memory policy. */
export const MEMORY_TOPICS_READ_ONLY_INTRO = [
    'Topic bodies are NOT injected — only metadata below.',
    'These topics are existing memory and are read-only in this session: do not try to create, update, or delete them. To READ a topic body: call `memory_topic_read` with the `name` shown below. To SEARCH by keyword across all topics: `memory_topic_search`.',
].join('\n');
// ── Block builders ─────────────────────────────────────────────────────────
export function buildUserProfileBlock(userProfile, capNote = '') {
    return [
        '<user_profile>',
        'What you know about the user so far:',
        '',
        userProfile + capNote,
        '',
        '---',
        USER_PROFILE_GUIDANCE,
        '</user_profile>',
    ].join('\n');
}
/**
 * `<agent_memory_summary>` — INDEX of your agent MEMORY.md.
 *
 * Mirrors daemon `buildMemorySummaryBlock` (opencode-plugin transform.ts).
 * Daemon's body text references the local fs via "Read the full file
 * directly"; cloud sandboxes have no fs so we substitute the equivalent
 * host tool — `memory_read(scope='agent')` — while preserving every
 * daemon cross-reference ("INDEX of your MEMORY.md", "older entries NOT
 * in the tail", "source: line ranges below", "Topic files listed
 * separately in `<available_memory_topics>`; this index does NOT cover
 * them").
 */
export function buildMemorySummaryBlock(summary) {
    return [
        '<agent_memory_summary>',
        MEMORY_SUMMARY_INTRO,
        '',
        summary,
        '</agent_memory_summary>',
    ].join('\n');
}
/**
 * `<agent_memory_tail>` — most recent slice of agent MEMORY.md.
 *
 * Mirrors daemon `buildMemoryTailBlock` (opencode-plugin transform.ts).
 * Daemon emits a `path="<absolute fs path>"` attribute and instructs the
 * agent to "Edit the file directly — do NOT append". Cloud has no fs,
 * so the open tag carries `scope="agent"` instead and the discipline
 * sentence maps fs-Edit/append to host tools:
 *
 *   - "Edit the file directly" → `memory_edit` with the smallest
 *     oldString that uniquely identifies the entry (UPDATE / MERGE /
 *     REMOVE an existing entry in place)
 *   - "do NOT append" → don't call `memory_append` for an UPDATE —
 *     `memory_append` is for NEW entries only
 *
 * This preserves daemon's invariant that LLM should never duplicate an
 * existing entry by appending a corrected copy.
 */
export function buildMemoryTailBlock(tail) {
    return [
        '<agent_memory_tail scope="agent">',
        MEMORY_TAIL_INTRO,
        '',
        tail,
        '</agent_memory_tail>',
    ].join('\n');
}
/**
 * `<agent_memory_note>` — emitted when MEMORY.md exceeded the injection
 * budget AND no summary was provided (otherwise the summary block
 * already explains the truncation).
 *
 * Mirrors daemon `buildMemoryNoteBlock` (opencode-plugin transform.ts);
 * daemon says "read <fs path>" — cloud says "call `memory_read`
 * (scope=agent)".
 */
export function buildMemoryNoteBlock() {
    return ['<agent_memory_note>', MEMORY_NOTE, '</agent_memory_note>'].join('\n');
}
export function buildDailyMemoryBlock(dailyMemory) {
    return [
        '<daily_digest>',
        'Recent daily summaries — what happened in the past few days.',
        '',
        dailyMemory,
        '</daily_digest>',
    ].join('\n');
}
/**
 * `<available_memory_topics>` block — cloud-adapted port of daemon's
 * `buildAvailableMemoryTopicsBlock`
 * (`packages/opencode-plugin/src/transform.ts:582-602`).
 *
 * **Body text + per-topic shape mirror daemon byte-for-byte** — same intro
 * sentences, same `<topic>` indentation, same `name:` / `desc:` key
 * order. The only deviation is the third per-topic key:
 *
 *   - daemon emits `path: <absolute fs path>` so the agent can hand the
 *     path to its `Read` tool to fetch the topic body on demand;
 *   - cloud sandboxes have no concept of a user fs path — the agent
 *     reaches topic bodies via the `memory_topic_read` host tool keyed
 *     by `name`, so we surface `size: <bytes>` instead. Size gives the
 *     LLM a cheap signal for "is this topic worth reading before I
 *     start writing on it?" without round-tripping to archon-server.
 *
 * Topic bodies are NOT injected here — only metadata. The agent pulls
 * bodies on demand via `memory_topic_read(topic_name)`. This matches the
 * daemon block's promise in the same sentence ("Topic bodies are NOT
 * injected — only metadata below").
 *
 * Returns the empty string when `topics` is empty; the composer guards
 * the call site so this rarely fires, but keeping the short-circuit
 * here makes the function safe to call unconditionally.
 *
 * Text content is XML-escaped (descriptions can carry literal `<` / `>`
 * / `&`); the pseudo-XML wrapper is not parsed by anyone but stays
 * structured for the model.
 */
export function buildAvailableMemoryTopicsBlock(topics) {
    if (topics.length === 0)
        return '';
    const lines = ['<available_memory_topics>', MEMORY_TOPICS_INTRO, ''];
    for (const t of topics) {
        lines.push('  <topic>', `    name: ${escapeXmlText(t.name)}`, `    desc: ${escapeXmlText(t.description)}`, `    size: ${String(t.size_bytes)} bytes`, '  </topic>');
    }
    lines.push('</available_memory_topics>');
    return lines.join('\n');
}
/**
 * XML-escape body text — used by `buildAvailableMemoryTopicsBlock` for
 * the user-derived topic name / description fields so a literal `</topic>`
 * or `&` in a description cannot break the surrounding pseudo-XML
 * structure (the model treats these blocks as structured even though
 * we don't run an XML parser).
 *
 * Mirrors daemon `transform.ts::escapeXmlText`.
 */
function escapeXmlText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * 本 turn effective skills → 共享目录条目(`planSkillCatalogWindow` 的 live 输入)。
 * 内置档:archon-server 的 builtin SkillRef 带 `mutable=false`(用户 Skill 是
 * `mutable=true`),订阅的全局 hosted Skill 带 `global=true`。Plugin Skill 由
 * `buildEffectiveSkillView` 也标成 `mutable=false`,但与本地一致不算内置
 * (官方 Office 四个由渲染器按名字归入内置档),所以要按来源排除。
 */
export function toSkillCatalogEntries(skills, isPluginSkill) {
    return skills.map((s) => ({
        name: s.name,
        description: s.description ?? '',
        builtin: s.global === true || (s.mutable === false && !isPluginSkill(s.name)),
    }));
}
/**
 * `<available_skills>` rendered afresh from `skills` for a host without the skill catalog
 * window: every name, descriptions in the budget by tier and name (no usage). The list
 * may already include Plugin Skills, which also carry `mutable=false`, so only subscribed
 * global Skills count as builtin here.
 */
export function renderSkillsCatalog(skills, contextWindowTokens) {
    return renderLocalSkillsCatalogResult(skills.map((s) => ({
        name: s.name,
        description: s.description ?? '',
        builtin: s.global === true,
    })), contextWindowTokens === undefined ? {} : { contextWindowTokens }).catalog;
}
/**
 * `AgentConfig.skill_usage`(archon-server 统计的 top-N)→ 共享渲染器的使用量表。
 * key 再规范化一次,和渲染器按 `normalizeSkillUsageKey(name)` 查表对齐;i64 在 JSON 上
 * 可能是 number 或十进制字符串。无效计数(非有限、负数)整条跳过;云端没有 firstSeen。
 */
export function toSkillCatalogUsage(skillUsage) {
    const usage = new Map();
    for (const [name, stat] of Object.entries(skillUsage ?? {})) {
        const key = normalizeSkillUsageKey(name);
        const useCount = Number(stat?.use_count);
        const lastUsedAtMs = Number(stat?.last_used_at_ms);
        if (!key || !Number.isFinite(useCount) || useCount < 0)
            continue;
        if (!Number.isFinite(lastUsedAtMs) || lastUsedAtMs < 0)
            continue;
        const existing = usage.get(key);
        usage.set(key, existing
            ? {
                useCount: existing.useCount + useCount,
                lastUsedAtMs: Math.max(existing.lastUsedAtMs, lastUsedAtMs),
            }
            : { useCount, lastUsedAtMs });
    }
    return usage;
}
/**
 * `<available_skills>` 目录(由 `planSkillCatalogWindow` 给出:窗口内冻结,名字全列,
 * 描述按使用频率在 min(2% context window, 5000 tokens) 预算内取舍)后追加
 * "如何创建新 skill" 的指引(绝对路径)。指引是云端独有:cloud SkillRef 没有 scope,
 * 只有一条创建路径 `${skillsDir}/<name>/SKILL.md`。`skillsDir` 必须是绝对路径(由
 * `server.ts:skillsDir = join(workspaceDir, '.skills')` 派生),与
 * `syncer.ts:discoverNewSkills` 扫描的同一个目录对齐 —— 模型按指引写文件,
 * session_end 时 syncer 才扫得到并自动同步。目录为空(没有 skill)时整块省略。
 */
export function buildSkillsBlock(catalog, skillsDir) {
    if (!catalog)
        return '';
    const instructions = [
        `To create a new skill, write its files under \`${skillsDir}/<name>/SKILL.md\`.`,
        'The skill syncer will automatically detect and upload new skills from this directory at session end.',
    ].join('\n');
    return `${catalog}\n\n${instructions}`;
}
export function buildBackgroundTaskFinishedBlock(tasks) {
    const entries = tasks.map((t) => {
        const desc = t.description?.trim() ? ` — ${t.description.trim()}` : '';
        return `  - ${t.taskId} [${t.status}]${desc}`;
    });
    return (`<background-task-finished>\n` +
        `These background tasks you started have finished since you last looked. Read each\n` +
        `one's result with the \`task_output\` tool (by task_id) and report what's relevant to\n` +
        `the user. This notice will not repeat for these tasks.\n${entries.join('\n')}\n</background-task-finished>`);
}
/**
 * 把 `staticPrompt` 里的 `DYNAMIC_BLOCKS_PLACEHOLDER` 替换成本 turn 实际
 * 的动态块(目前只有 skills)。目录为空时占位符替换成空字符串。
 *
 * `skillsCatalog` 是窗口计划给出的目录原文(不在这里重新渲染);`skillsDir` 是绝对路径,
 * 透传到 `buildSkillsBlock` 用作指引文案中的目标位置。
 */
export function injectDynamicBlocks(staticPrompt, skillsCatalog, skillsDir) {
    return staticPrompt.replace(DYNAMIC_BLOCKS_PLACEHOLDER, buildSkillsBlock(skillsCatalog, skillsDir));
}
//# sourceMappingURL=prompt-blocks.js.map