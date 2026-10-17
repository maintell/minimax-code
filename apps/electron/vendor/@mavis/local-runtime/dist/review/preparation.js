import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const REVIEW_PROMPT_KEYS = {
    reviewer: 'workflow/code-review/reviewer-system.md',
    candidates: 'workflow/code-review/review-candidates.md',
};
export class ReviewPreparationService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async prepare(input, promptTemplates) {
        const responseLanguage = this.deps.regionGetter() === 'cn' ? 'zh-CN' : 'en';
        const mode = input.requestedMode ?? resolveConfiguredMode(this.deps.configGetter());
        const [templates, userRules, gitContext] = await Promise.all([
            Promise.resolve(promptTemplates),
            this.deps.preferences.get(),
            collectChangedLines(input.workspace),
        ]);
        const context = {
            reviewRunId: `review_${randomUUID()}`,
            workspace: input.workspace,
            responseLanguage,
            ...gitContext,
        };
        const responseLanguageInstruction = buildResponseLanguageInstruction(responseLanguage);
        const customRules = userRules.trim()
            ? [
                '',
                '## User review rules',
                '',
                'Apply these user-authored rules when they do not conflict with the reviewer instructions above:',
                '<user-review-rules>',
                escapeClosingTag(userRules, 'user-review-rules'),
                '</user-review-rules>',
            ].join('\n')
            : '';
        return {
            mode,
            trigger: input.trigger,
            responseLanguage,
            reviewPrompt: [
                templates.reviewer.trim(),
                templates.candidates.trim(),
                `## Required response language for this run\n\n${responseLanguageInstruction}`,
            ].join('\n\n') + customRules,
            displayPrompt: input.request,
            request: input.request,
            context,
        };
    }
}
export function resolveBuiltinReviewPromptDir() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/prompts/code-review');
}
export async function loadBuiltinReviewPromptTemplates(promptDir) {
    const [reviewer, candidates] = await Promise.all([
        loadReviewPrompt(promptDir, 'reviewer-system.md'),
        loadReviewPrompt(promptDir, 'review-candidates.md'),
    ]);
    return { reviewer, candidates };
}
function resolveConfiguredMode(config) {
    return config.review?.mode === 'inline' ? 'inline' : 'subagent';
}
function buildResponseLanguageInstruction(language) {
    return language === 'zh-CN'
        ? '本次所有面向用户的审查文本必须使用简体中文。该要求适用于 summary、每个 finding 的 title 和 content，以及没有可报告问题时的普通文本结论；代码标识符、文件路径和原始错误文本可以保留原文。'
        : 'All user-facing review text for this run must be written in English. This applies to the summary, every finding title and content, and the ordinary-text conclusion when there are no reportable issues; code identifiers, file paths, and original error text may remain unchanged.';
}
async function collectChangedLines(workspace) {
    try {
        const [{ stdout: trackedOutput }, { stdout: untrackedOutput }] = await Promise.all([
            execGit(workspace, ['diff', '--name-status', '-z', 'HEAD', '--']),
            execGit(workspace, ['ls-files', '--others', '--exclude-standard', '-z']),
        ]);
        const tracked = parseNameStatus(trackedOutput);
        const untracked = splitNul(untrackedOutput);
        const changedFiles = new Map();
        const warnings = [];
        for (const file of tracked) {
            const path = file.path;
            try {
                const { stdout } = await execGit(workspace, [
                    'diff',
                    '--unified=0',
                    '--no-color',
                    'HEAD',
                    '--',
                    path,
                ]);
                changedFiles.set(path, {
                    ...file,
                    ranges: parseChangedLineRanges(stdout),
                });
            }
            catch {
                changedFiles.set(path, { ...file, ranges: [] });
                warnings.push({ code: 'revision_failed', path });
            }
        }
        for (const path of untracked) {
            try {
                const text = await readFile(resolve(workspace, path), 'utf8');
                const lineCount = countTextLines(text);
                changedFiles.set(path, {
                    path,
                    status: 'added',
                    ranges: lineCount > 0 ? [{ side: 'new', kind: 'added', startLine: 1, endLine: lineCount }] : [],
                });
            }
            catch {
                changedFiles.set(path, { path, status: 'added', ranges: [] });
                warnings.push({ code: 'revision_failed', path });
            }
        }
        return {
            revisionStatus: warnings.length > 0 ? 'partial' : 'available',
            changedFiles,
            ...(warnings.length > 0 ? { warnings } : {}),
        };
    }
    catch {
        return {
            revisionStatus: 'unavailable',
            warnings: [{ code: 'git_state_failed' }],
        };
    }
}
export function parseChangedLineRanges(diff) {
    const ranges = [];
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gmu;
    for (const match of diff.matchAll(hunk)) {
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        if (oldCount > 0) {
            ranges.push({
                side: 'old',
                kind: newCount > 0 ? 'modified' : 'deleted',
                startLine: oldStart,
                endLine: oldStart + oldCount - 1,
            });
        }
        if (newCount > 0) {
            ranges.push({
                side: 'new',
                kind: oldCount > 0 ? 'modified' : 'added',
                startLine: newStart,
                endLine: newStart + newCount - 1,
            });
        }
    }
    return ranges;
}
function parseNameStatus(output) {
    const values = splitNul(output);
    const files = [];
    for (let index = 0; index < values.length;) {
        const code = values[index++] ?? '';
        const firstPath = values[index++] ?? '';
        if (!code || !firstPath)
            break;
        if (code.startsWith('R') || code.startsWith('C')) {
            const path = values[index++] ?? '';
            if (!path)
                break;
            files.push({
                path,
                previousPath: firstPath,
                status: 'renamed',
                ranges: [],
            });
            continue;
        }
        files.push({
            path: firstPath,
            status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
            ranges: [],
        });
    }
    return files;
}
async function execGit(workspace, args) {
    const result = await execFileAsync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout };
}
function splitNul(value) {
    return value.split('\0').filter(Boolean);
}
function countTextLines(value) {
    if (!value)
        return 0;
    const lines = value.split(/\r\n|\n|\r/u);
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines.length;
}
async function loadReviewPrompt(promptDir, fileName) {
    const filePath = resolve(promptDir, fileName);
    try {
        return await readFile(filePath, 'utf8');
    }
    catch (cause) {
        throw new Error(`Failed to load built-in code review prompt: ${filePath}`, { cause });
    }
}
function escapeClosingTag(value, tag) {
    return value.replace(new RegExp(`</${tag}>`, 'giu'), `&lt;/${tag}&gt;`);
}
//# sourceMappingURL=preparation.js.map