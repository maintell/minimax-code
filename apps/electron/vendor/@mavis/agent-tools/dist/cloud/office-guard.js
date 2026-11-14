/**
 * Cloud-runtime office file direct-edit guard.
 *
 * Throws `OfficeGuardError` when a tool tries to Read/Write/Edit Office files
 * directly. The error message routes the agent to the matching official
 * Office plugin skill (`pdf:pdf` / `word:docx` / `excel:xlsx` / `ppt:pptx`).
 *
 * Scope (Office 4 件套):
 *   - .pdf                          → pdf:pdf
 *   - .doc / .docx / .docm           → word:docx
 *   - .xlsx / .xlsm / .xlsb / .xls   → excel:xlsx
 *   - .pptx / .pptm / .ppt           → ppt:pptx
 *
 * Out of scope (intentionally allowed through):
 *   - .csv / .tsv (plain text, not Office)
 *   - all other extensions
 *
 * Behavior matrix:
 *   - PDF Read: only block when >20 pages (size gate aligned with pdf
 *     SKILL.md operational rule §2); small PDFs pass through.
 *   - PDF Write/Edit: always block (binary container).
 *   - DOC/DOCX/DOCM/XLSX/XLSM/XLSB/XLS/PPTX/PPTM/PPT Read/Write/Edit:
 *     always block (OOXML zip / BIFF binary archives silently corrupt on
 *     hand-edit).
 *
 * Fail-open: any probe error / missing PDF signature / zero hit returns null,
 * the guard treats null as allow. This matches the daemon-side
 * `binary-read-guard` philosophy — we prefer false-negative (let a corrupt
 * PDF through and let pi handle the decode failure) over false-positive
 * (block a legitimate read because our probe was confused).
 *
 * ─── Activation model — archon-server controlled (NOT build-in) ────────────
 *
 * Following archon-server's content-safety hook precedent, this guard is
 * **disabled by default** in cloud-runtime. It only activates when
 * archon-server downloads a builtin hook entry named `office-intercept`
 * with event `pre_tool_use` via `HarnessControlReq.AgentConfig.Hooks`.
 *
 * archon-server defines two layers:
 *   1. Apollo `builtin_hooks` config: `[{ "name": "office-intercept",
 *      "event": "PreToolUse", "agent_template_allow_list": [...] }]`
 *      — controls **which agent templates** activate the guard.
 *   2. `internal/domain/agent/service/assembler.go` step 5: merges the
 *      filtered builtin hooks into `AgentConfig.Hooks` and sends them
 *      downstream.
 *
 * Why the body is empty on the wire: archon-server's `BuiltinHookMeta`
 * intentionally carries only metadata (name / event / template scope) —
 * **the body is never executed by `CloudRuntimeHookRunner`**. Real builtin
 * hooks have hardcoded handlers in cloud-runtime that key off the name
 * (see `runtime-hook-runner.ts` skip-when-body-empty, and
 * `run-pi-turn.ts:hasRuntimeHook` precedent for archon safety check).
 * This file is one of those handlers: `hasOfficeGuardGate(config)` decides
 * whether to engage, and `assertOfficeGuard` is the body.
 *
 * Hot toggle: flipping `enabled` in the Apollo config or restricting the
 * allow-list reaches cloud-runtime on the next session start without a
 * cloud-runtime image rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookEvent } from '@mavis/protocol';
/**
 * Model-facing runtime names of the official Office plugin skills
 * (`<plugin>:<skill>`, see `buildPluginSkillRuntimeName`). The Office
 * skills used to be hosted builtin skills named `pdf` / `docx` / `xlsx` /
 * `pptx`; they now ship as the default-installed Word / Excel / PDF / PPT
 * marketplace plugins, so deny messages must point at the plugin names.
 * Keep this in sync with the official marketplace entries and the catalog
 * tier list in `@mavis/context-manager` `skill-catalog.ts`.
 */
export const OFFICE_SKILL_BY_KIND = {
    pdf: 'pdf:pdf',
    docx: 'word:docx',
    xlsx: 'excel:xlsx',
    pptx: 'ppt:pptx',
};
export const OFFICE_SKILL_NAMES = [
    OFFICE_SKILL_BY_KIND.pdf,
    OFFICE_SKILL_BY_KIND.docx,
    OFFICE_SKILL_BY_KIND.xlsx,
    OFFICE_SKILL_BY_KIND.pptx,
];
/** Aligned with pdf SKILL.md operational rule §2 (>20 pages → locate-first mandatory). */
export const PDF_PAGE_BLOCK_THRESHOLD = 20;
/** Cap how many bytes are scanned from the head of the PDF when probing page count. */
export const PDF_PAGE_PROBE_BYTES = 4 * 1024 * 1024;
const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.doc', '.docx', '.docm']);
const XLSX_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls']);
const PPTX_EXTENSIONS = new Set(['.pptx', '.pptm', '.ppt']);
function normalizeFilePath(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'file:')
            return fileURLToPath(url);
    }
    catch {
        // Not a URL — keep original path.
    }
    return value;
}
/**
 * Resolve whether the given file path is an Office file the guard should
 * intervene on, and which skill owns the routing.
 *
 * Returns `null` for non-Office paths (csv / tsv / md / source code / etc.).
 * Always returns `null` for empty / non-string input so callers can pass
 * `toolArgs.file_path` directly without pre-validating.
 */
export function resolveOfficeHit(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0)
        return null;
    const local = normalizeFilePath(filePath);
    const ext = path.extname(local).toLowerCase();
    if (PDF_EXTENSIONS.has(ext)) {
        return {
            filePath,
            localFilePath: local,
            ext,
            kind: 'pdf',
            skillName: OFFICE_SKILL_BY_KIND.pdf,
        };
    }
    if (DOCX_EXTENSIONS.has(ext)) {
        return {
            filePath,
            localFilePath: local,
            ext,
            kind: 'docx',
            skillName: OFFICE_SKILL_BY_KIND.docx,
        };
    }
    if (XLSX_EXTENSIONS.has(ext)) {
        return {
            filePath,
            localFilePath: local,
            ext,
            kind: 'xlsx',
            skillName: OFFICE_SKILL_BY_KIND.xlsx,
        };
    }
    if (PPTX_EXTENSIONS.has(ext)) {
        return {
            filePath,
            localFilePath: local,
            ext,
            kind: 'pptx',
            skillName: OFFICE_SKILL_BY_KIND.pptx,
        };
    }
    return null;
}
/**
 * Best-effort PDF page count via head-of-file byte scan.
 *
 * Returns `null` when the file is unreadable, missing the `%PDF-` signature,
 * or contains no recognizable `/Type /Page` markers (compressed object
 * streams, encrypted/malformed PDFs). The guard treats `null` as "allow" —
 * matching the fail-open contract documented at the top of this file.
 */
export function countPdfPagesSync(filePath, limitBytes = PDF_PAGE_PROBE_BYTES) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(limitBytes);
        const bytesRead = fs.readSync(fd, buf, 0, limitBytes, 0);
        if (bytesRead <= 0)
            return null;
        const head = buf.subarray(0, bytesRead).toString('latin1');
        if (!head.includes('%PDF-'))
            return null;
        // /Type /Page (NOT /Pages); allow whitespace between /Type and /Page.
        const re = /\/Type\s*\/Page(?!s)/g;
        let count = 0;
        while (re.exec(head) !== null)
            count += 1;
        return count > 0 ? count : null;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // noop
            }
        }
    }
}
/**
 * Error thrown when the office guard blocks a tool call. Carries enough
 * structured context (kind, skill, tool, original path) for the caller to
 * decorate the message or route to a richer UI; the `message` is already
 * fully formed for direct surface to the LLM.
 */
export class OfficeGuardError extends Error {
    filePath;
    kind;
    skillName;
    tool;
    constructor(filePath, kind, skillName, tool, message) {
        super(message);
        this.filePath = filePath;
        this.kind = kind;
        this.skillName = skillName;
        this.tool = tool;
        this.name = 'OfficeGuardError';
    }
}
function buildPdfReadAbortReason(filePath, pages) {
    return (`Direct Read on large PDFs is forbidden. ` +
        `${filePath} has ~${pages} pages (>${PDF_PAGE_BLOCK_THRESHOLD}); use the '${OFFICE_SKILL_BY_KIND.pdf}' skill instead. ` +
        `Locate-first is mandatory at this size: build a heading index (pypdf outline → printed TOC → keyword grep), ` +
        `then extract the matching pages. See pdf SKILL.md operational rule §2 / docs/read-guide.md §3.`);
}
function buildPdfWriteAbortReason(filePath, tool) {
    return (`Direct ${tool} on PDF files is forbidden. ` +
        `${filePath} is a binary container — it cannot be hand-edited as text. ` +
        `Use the '${OFFICE_SKILL_BY_KIND.pdf}' skill: REFORMAT (markdown→pdf), CREATE (HTML→pdf), FILL (forms), or MUTATE (qpdf/pypdf cookbook). ` +
        `See pdf SKILL.md route table.`);
}
function buildDocxAbortReason(filePath, tool) {
    return (`Direct ${tool} on DOC/DOCX files is forbidden. ` +
        `${filePath} is an OOXML zip archive — Read/Write/Edit silently corrupts content controls, styles, and numbering. ` +
        `Use the '${OFFICE_SKILL_BY_KIND.docx}' skill scripts (read / diff / render / full) instead. ` +
        `See docx SKILL.md routes.`);
}
function buildXlsxAbortReason(filePath, tool) {
    return (`Direct ${tool} on XLSX/XLS files is forbidden. ` +
        `${filePath} is an OOXML zip (or BIFF binary) — Read/Write/Edit silently corrupts formulas, named ranges, ` +
        `pivot tables, slicers, and number formats. Use the '${OFFICE_SKILL_BY_KIND.xlsx}' skill: pandas + openpyxl for read/write, ` +
        `scripts/recalc.py for formula evaluation, and SKILL.md §3-§5 for the formula-first convention. ` +
        `See xlsx SKILL.md.`);
}
function buildPptxAbortReason(filePath, tool) {
    return (`Direct ${tool} on PPTX/PPT files is forbidden. ` +
        `${filePath} is an OOXML zip — Read/Write/Edit silently corrupts slide masters, layouts, theme colors, ` +
        `and embedded shapes/charts. Use the '${OFFICE_SKILL_BY_KIND.pptx}' skill: extract_pptx.py / audit_pptx.py for inspection, ` +
        `PptxGenJS for generation, and SKILL.md template imitation workflow for style preservation. ` +
        `See pptx SKILL.md.`);
}
/**
 * The reserved builtin hook name that archon-server downloads (via Apollo
 * `builtin_hooks`) to activate this guard. Exported so tests and the
 * archon-server side (when authoring the Apollo config) can reference the
 * single source of truth instead of typing the string twice.
 */
export const OFFICE_GUARD_HOOK_NAME = 'office-intercept';
/**
 * Decide whether the office guard should engage for the current call.
 *
 * Returns `true` IFF the resolved `AgentConfig` carries a hook named
 * `office-intercept` (case-sensitive) with `event === 'pre_tool_use'` and
 * `enabled !== false`. Source of that hook entry is archon-server's
 * Apollo `builtin_hooks` config + `agent_template_allow_list` filter — see
 * the file header for the activation model.
 *
 * Returns `false` when:
 *   - `agentConfig` is missing (out-of-band cloud tool callers without
 *     full per-turn context — e.g. unit tests that just instantiate the
 *     tool without going through SessionController)
 *   - the hook list is empty (default cloud-runtime state — no builtin
 *     office hook downloaded)
 *   - the hook is present but disabled (operator hot-toggled it off via
 *     Apollo without changing the cloud-runtime image)
 *
 * The "default off" semantic is intentional and matches user expectation:
 * cloud-runtime ships the guard code dormant; archon-server alone decides
 * activation per agent template, runtime-flippable.
 */
export function hasOfficeGuardGate(agentConfig) {
    const hooks = agentConfig?.hooks ?? [];
    for (const hook of hooks) {
        if (hook.name === OFFICE_GUARD_HOOK_NAME &&
            hook.event === HookEvent.PRE_TOOL_USE &&
            hook.enabled !== false) {
            return true;
        }
    }
    return false;
}
/**
 * Assert that the given tool call is allowed against the given file path.
 * Throws `OfficeGuardError` when the call should be blocked.
 *
 * Parameters:
 *   - `tool`           which Office tool the agent invoked (Read / Write / Edit)
 *   - `filePath`       path AS PASSED BY THE LLM (pre-workspace-resolution);
 *                      used verbatim in the deny message so the LLM sees the
 *                      same path it sent
 *   - `localFilePath`  resolved absolute path on the cloud sandbox filesystem,
 *                      used for the PDF page-count probe; defaults to
 *                      `filePath` when caller does not separate the two
 *   - `options`        test injection seam for the page-count probe
 *
 * The caller is responsible for invoking this AFTER the workspace path
 * resolution succeeds — there is no point probing a path that the workspace
 * guard already rejected.
 */
export function assertOfficeGuard(tool, filePath, localFilePath = filePath, options = {}) {
    const hit = resolveOfficeHit(filePath);
    if (!hit)
        return;
    if (hit.kind === 'pdf') {
        if (tool === 'Read') {
            const probe = options.countPdfPages ?? countPdfPagesSync;
            const pages = probe(localFilePath);
            if (pages !== null && pages > PDF_PAGE_BLOCK_THRESHOLD) {
                throw new OfficeGuardError(filePath, 'pdf', OFFICE_SKILL_BY_KIND.pdf, tool, buildPdfReadAbortReason(filePath, pages));
            }
            return;
        }
        throw new OfficeGuardError(filePath, 'pdf', OFFICE_SKILL_BY_KIND.pdf, tool, buildPdfWriteAbortReason(filePath, tool));
    }
    if (hit.kind === 'docx') {
        throw new OfficeGuardError(filePath, 'docx', OFFICE_SKILL_BY_KIND.docx, tool, buildDocxAbortReason(filePath, tool));
    }
    if (hit.kind === 'xlsx') {
        throw new OfficeGuardError(filePath, 'xlsx', OFFICE_SKILL_BY_KIND.xlsx, tool, buildXlsxAbortReason(filePath, tool));
    }
    // pptx — exhaustive switch over OfficeKind.
    throw new OfficeGuardError(filePath, 'pptx', OFFICE_SKILL_BY_KIND.pptx, tool, buildPptxAbortReason(filePath, tool));
}
//# sourceMappingURL=office-guard.js.map