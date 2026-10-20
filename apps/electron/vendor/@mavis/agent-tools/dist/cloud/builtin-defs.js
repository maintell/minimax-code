import { Type } from '@sinclair/typebox';
export const CloudReadToolDef = {
    name: 'read',
    executionMode: 'parallel',
    // Read guidance and parameter descriptions stay aligned with LocalReadToolDef;
    // only the filesystem scope differs. read-defs-contract tests enforce parity.
    description: 'Reads a file from the cloud sandbox workspace.\n\n' +
        '- `path` must stay inside the sandbox workspace; host machine paths are not exposed.\n' +
        '- Text reads return up to 2000 lines, subject to byte limits. Use `offset` and `limit` to read only the part you need.\n' +
        '- Text results include line numbers starting at 1.\n' +
        "- Follow a truncated result's continuation instructions only if you need the omitted text. When `next_offset` is provided, use that exact value with the same `path`.\n" +
        '- Reads images (jpg, png, gif, webp) and presents them visually.\n' +
        '- Reads PDFs via `pages` (required for PDFs over 10 pages; max 20 pages/request), and Jupyter notebooks (.ipynb) as cells with outputs.\n' +
        '- Reads videos (mp4, avi, mov, mkv) when the active model supports video.\n' +
        '- Directories, missing files, unsupported binary files, and empty files return an error or system reminder.\n' +
        '- Reuse current file content already in context. Re-read when it may be stale or to resolve uncertain content or failed matches; do not re-read solely to confirm a successful edit/write.',
    schema: Type.Object({
        path: Type.String({ description: 'Sandbox workspace-relative or workspace-contained path.' }),
        offset: Type.Optional(Type.Number({
            description: 'Starting line for text files (1-indexed).',
        })),
        limit: Type.Optional(Type.Number({
            description: 'Maximum number of text lines to read.',
        })),
        pages: Type.Optional(Type.String({
            description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request. Text offsets and limits are ignored for PDFs.',
        })),
    }),
};
export const CloudWriteToolDef = {
    name: 'write',
    executionMode: 'sequential',
    // Usage guidance stays aligned with LocalWriteToolDef; path scopes differ.
    description: 'Writes a file inside the cloud sandbox workspace, overwriting if it exists and creating parent directories as needed.\n\n' +
        '- `path` must stay inside the sandbox workspace; host machine paths are not exposed.\n' +
        '- Use for new files or complete rewrites; use `edit` for partial changes.\n' +
        '- Read existing content before overwriting it. Provide the complete replacement content.\n' +
        '- Content is written literally, including line endings.\n' +
        '- On success, reports the number of bytes written and whether an existing file was overwritten.\n' +
        '- Do not proactively create documentation files unless explicitly requested.',
    schema: Type.Object({
        path: Type.String({ description: 'Sandbox workspace-relative or workspace-contained path.' }),
        content: Type.String({ description: 'Full file content to write.' }),
    }),
};
const CloudEditToolSchema = Type.Object({
    file_path: Type.String({
        description: 'Sandbox workspace-relative or workspace-contained path to the file to modify.',
    }),
    old_string: Type.String({ description: 'The text to replace.' }),
    new_string: Type.String({
        description: 'The text to replace it with (must be different from old_string).',
    }),
    replace_all: Type.Optional(Type.Boolean({
        description: 'Replace all occurrences of old_string. Default is false.',
        default: false,
    })),
}, { additionalProperties: false });
export const CloudEditToolDef = {
    name: 'edit',
    executionMode: 'sequential',
    // Usage guidance stays aligned with LocalEditToolDef; path scopes differ.
    description: 'Performs exact string replacement in a file inside the cloud sandbox workspace.\n\n' +
        '- `file_path` must stay inside the sandbox workspace; host machine paths are not exposed.\n' +
        '- Use current file content from `read` or your own successful edit/write. Read the file first if that content is unavailable or may be stale.\n' +
        '- `old_string` must be non-empty and match the file exactly, including whitespace and indentation. It must be unique unless `replace_all` is true; otherwise the edit fails.\n' +
        '- `replace_all: true` replaces every occurrence instead.',
    schema: CloudEditToolSchema,
};
export const CloudBashToolDef = {
    name: 'bash',
    executionMode: 'sequential',
    description: [
        'Execute a shell command in the cloud sandbox executor. The command runs in the sandbox environment, not in the user host shell. Output is combined stdout + stderr after the command exits. Each call starts from the runtime-defined workspace context; scope directory changes inside the same command or use absolute sandbox paths.',
        '',
        '# Git',
        '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.',
        '- Use the `gh` CLI for GitHub operations (PRs, issues, API).',
        '- Commit or push only when the user asks.',
    ].join('\n'),
    schema: Type.Object({
        command: Type.String({ description: 'Shell command line to execute in the sandbox.' }),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds. Default is host-defined.' })),
    }),
};
export const CloudGrepToolDef = {
    name: 'grep',
    executionMode: 'parallel',
    description: 'Search file contents inside the cloud sandbox workspace using ripgrep. ALWAYS use this tool for content search — NEVER invoke `grep`/`rg` via bash (that would bypass sensitive-file filtering and permission review). Returns only the paths of matching files by default (`output_mode="files_with_matches"`) — use it to locate relevant files, then use `read` to view their contents and `edit` to change them. Set `output_mode="content"` to get matching lines (supports `context` and paging) or `"count"` for per-file match counts. Respects .gitignore (use bash `rg --no-ignore` for ignored files); sensitive files are always excluded. Results are truncated at `limit`; page through more with `offset`.',
    schema: Type.Object({
        pattern: Type.String({ description: 'Regex pattern (or literal if `literal=true`).' }),
        path: Type.Optional(Type.String({ description: 'Workspace-contained directory or file to search.' })),
        glob: Type.Optional(Type.String({ description: "File-glob filter, e.g. '*.ts' or '**/*.spec.ts'." })),
        output_mode: Type.Optional(Type.Union([Type.Literal('files_with_matches'), Type.Literal('content'), Type.Literal('count')], {
            description: 'Output shape: "files_with_matches" (default) lists matching file paths only; "content" shows matching lines with line numbers; "count" shows per-file match counts.',
        })),
        ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search.' })),
        literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal string instead of regex.' })),
        context: Type.Optional(Type.Number({
            description: 'Lines of context before and after each match. Only applies to output_mode="content".',
        })),
        limit: Type.Optional(Type.Number({ description: 'Maximum number of results to return.' })),
        offset: Type.Optional(Type.Number({
            description: 'Skip the first N results (matches in content mode, files/entries otherwise). Use with `limit` to page.',
        })),
    }),
};
export const CloudGlobToolDef = {
    name: 'glob',
    executionMode: 'parallel',
    description: 'Search for files by glob pattern inside the cloud sandbox workspace. ALWAYS use this tool to find files by name/pattern — NEVER use `find`/`ls -R` via bash (that would bypass sensitive-file filtering and permission review). Gitignored files ARE listed (build artifacts stay findable); sensitive files are always excluded. Returns workspace-relative file paths, truncated when results exceed the limit; pass sort="modified" to list recently changed files first.',
    schema: Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.tsx'." }),
        path: Type.Optional(Type.String({ description: 'Workspace-contained search root.' })),
        limit: Type.Optional(Type.Number({ description: 'Maximum number of file paths to return.' })),
        sort: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('modified')], {
            description: 'Result ordering: "none" (default, fastest) or "modified" (recently changed first — useful when results may be truncated).',
        })),
    }),
};
export const CloudTodoWriteToolDef = {
    name: 'todowrite',
    executionMode: 'sequential',
    description: 'Replace the visible session task list with a complete snapshot.\n\n' +
        '- Use for multiple meaningful steps or an explicit task-list request; skip single-step, trivial, or conversational work.\n' +
        '- Keep items concise and reflect actual progress. Mark an item `in_progress` before starting; at most one may be `in_progress`.\n' +
        '- Mark finished work `completed` and obsolete work `cancelled` promptly.\n' +
        '- Before final delivery, reconcile statuses with actual work and reported completion. Updating the list does not complete the work.',
    schema: Type.Object({
        todos: Type.Array(Type.Object({
            content: Type.String({ description: 'Brief description of the task' }),
            status: Type.String({
                description: 'Current status of the task: pending, in_progress, completed, cancelled',
            }),
            priority: Type.String({
                description: 'Priority level of the task: high, medium, low',
            }),
        }), {
            description: 'The complete updated list, including unchanged items. An empty list clears it.',
        }),
    }),
};
export const CLOUD_TASK_TOOL_DESCRIPTION = `Launch a cloud sub-agent to handle complex, multistep tasks autonomously.

Use this for broad research, parallelizable investigation, or delegated implementation. Do not use it for targeted file reads, grep-style code searches, or work that is simpler to do directly.

When background execution is enabled, invocations start in the background by default and return a task id immediately. A started task is not a completed result. Set run_in_background=false when you need the child agent's final result before continuing. Use the background task control tools to query, read output, or stop background work.`;
export const CloudTaskToolDef = {
    name: 'task',
    executionMode: 'sequential',
    description: CLOUD_TASK_TOOL_DESCRIPTION,
    schema: Type.Object({
        description: Type.String({
            description: 'A short (3-5 words) description of the task',
        }),
        prompt: Type.String({
            description: 'The task for the agent to perform',
        }),
        agent_name: Type.Optional(Type.String({
            description: 'Canonical agent name to run. Do not use a display name.',
        })),
        subagent_type: Type.Optional(Type.String({
            description: 'Legacy specialized-agent alias. Prefer agent_name for new calls.',
        })),
        run_in_background: Type.Optional(Type.Boolean({
            description: 'Optional; defaults to background execution when it is enabled. Set false to wait for the final result. True starts background execution and returns a task id immediately. Inspect or control a background task with task_query, task_output, and task_stop.',
        })),
    }),
};
export const CLOUD_BASE_TOOL_DEFS = [
    CloudReadToolDef,
    CloudWriteToolDef,
    CloudEditToolDef,
    CloudBashToolDef,
    CloudGrepToolDef,
    CloudGlobToolDef,
    CloudTodoWriteToolDef,
    CloudTaskToolDef,
];
//# sourceMappingURL=builtin-defs.js.map