import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import { PTC_SCRIPT_DESCRIPTION_PREFIX, ptcScriptDescriptionFromFirstLine, ptcScriptFirstLine, ptcScriptSingleLine, } from './ptc-script-text.js';
export const SAVE_PTC_SCRIPT_NAME = 'save_run_code_script';
/**
 * The code a refused overwrite reports, so the save metric can label it
 * `exists` instead of a generic `rejected`. local-runtime-v2 repeats it
 * (execution/ptc/saved-script-record.ts) because the orchestration core may
 * not value-import this package; saved-script-record.test.ts keeps them equal.
 */
export const PTC_SCRIPT_SAVE_EXISTS_CODE = 'PTC_SCRIPT_SAVE_EXISTS';
/** Fixed wording; the proposal says the Agent, not a permission gate, asks the user. */
export const SAVE_PTC_SCRIPT_DESCRIPTION = 'Save a working run_code program as a reusable script file, so later run_code calls can run it with run_code({ path, args, description }) or load it with await import(path). It is not a Browser run_script file. Get the code working in run_code first, then wrap it as export default async function (args) { ... } with a header comment. Use scope "project" by default; it writes to .minimax/ptc/. Before scope "user", which every project can use, ask the user in the conversation and wait for agreement, unless the user already asked for it. A subagent that cannot ask the user uses scope "project". Before overwriting a script you did not write in this conversation, ask the user too. Save only when the user asks or the logic will clearly be reused, and tell the user the saved path. To remove a script, delete its file with bash.';
/** The fixed usage sentence in the tool result, so the first save teaches the call form. */
export function savedPtcScriptUsage(path) {
    return `Saved to ${path}. Run it with run_code({ path, args, description }).`;
}
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const SavePtcScriptSchema = Type.Object({
    name: Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'File name without an extension, for example "session-stats". Letters, digits, dot, dash and underscore only.',
    }),
    scope: Type.Union([Type.Literal('project'), Type.Literal('user')], {
        description: 'project writes to .minimax/ptc/ in the workspace; user writes to the shared user directory every project can use.',
    }),
    description: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 1_024,
        description: 'One line on what the script does and when to use it; written as the first line of the file.',
    })),
    content: Type.String({
        // No maxLength: script length is not budgeted, so a long module is not a
        // malformed call. The loader reads it whole.
        minLength: 1,
        description: 'The complete ES module.',
    }),
    overwrite: Type.Optional(Type.Boolean({
        description: 'Default false: a script with the same name already existing is an error.',
    })),
});
/**
 * Creates the `save_run_code_script` tool. It writes directly: no write permission
 * or approval code is involved, so the checks below are its whole boundary.
 */
export function createSavePtcScriptTool(environment) {
    return defineRuntimeTool({
        name: SAVE_PTC_SCRIPT_NAME,
        label: 'Save run_code script',
        description: SAVE_PTC_SCRIPT_DESCRIPTION,
        schema: SavePtcScriptSchema,
        executionMode: 'sequential',
        source: 'builtin',
        execute: async (_context, input) => {
            try {
                return savePtcScript(environment, input);
            }
            catch (error) {
                return failedSave(error instanceof Error ? error.message : String(error), saveFailureCode(error));
            }
        },
    });
}
function savePtcScript(environment, input) {
    if (!NAME_PATTERN.test(input.name)) {
        throw new Error(`save_run_code_script name must be 1-64 characters of [A-Za-z0-9._-] with no path separator: ${JSON.stringify(input.name)}`);
    }
    const content = withDescriptionHeader(input.content, input.description);
    // Reported in the result and matched by the loader's digest; not a limit.
    const bytes = Buffer.byteLength(content, 'utf8');
    // Before anything touches the disk: a specifier the loader always refuses
    // would only produce a script that fails on its first import, in some later
    // Session that cannot tell why.
    const refusedImport = environment.refusedImport(content);
    if (refusedImport !== undefined)
        throw new Error(refusedImportMessage(refusedImport));
    const target = scriptTarget(environment, input.scope);
    const directory = resolve(target.directory);
    const path = join(directory, `${input.name}.mjs`);
    environment.assertNoSymlink(directory, target.boundary);
    environment.assertNoSymlink(path, target.boundary);
    const existing = existingScriptKind(path);
    if (existing !== 'none' && input.overwrite !== true) {
        throw new PtcScriptExistsError(`save_run_code_script: ${path} already exists. Pass overwrite: true to replace it, after asking the user when you did not write it in this conversation.`);
    }
    if (existing === 'other') {
        throw new Error(`save_run_code_script: ${path} exists and is not a regular file, so it cannot be overwritten.`);
    }
    mkdirSync(directory, { recursive: true });
    // The directory need not have existed when it was first checked, and the
    // user-level directory is created by this very call, so both checks run
    // again once it is really on disk: a `ptc` that appeared as a symlink in
    // between is refused before anything is written.
    environment.assertNoSymlink(directory, target.boundary);
    environment.assertNoSymlink(path, target.boundary);
    // Written beside the target and published atomically, so a failed write
    // never leaves a half-written script that the catalog would list. The
    // temporary name is random and created exclusively, so two saves in the same
    // millisecond, or a name another process already took, can never be written
    // through.
    const temporary = join(directory, `.${input.name}.${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    const overwritten = existing === 'file';
    publishScript(temporary, path, overwritten, input.overwrite === true);
    assertStillInsideBoundary(path, target.boundary);
    // The same digest the loader records in `sources`, so a program can compare
    // what it just wrote with what a later run loads.
    const sha256 = createHash('sha256').update(content).digest('hex');
    const text = savedPtcScriptUsage(path);
    return withDesktopCompletenessReport(SAVE_PTC_SCRIPT_NAME, {
        tool_name: SAVE_PTC_SCRIPT_NAME,
        text,
        content: [{ type: 'text', text }],
        details: { path, scope: input.scope, bytes, sha256, overwritten },
    }, { data: { path, scope: input.scope, bytes, sha256, overwritten } });
}
/**
 * The path was checked for symlinks before the write; this repeats the check on
 * the realpath after the rename, because a component of the directory could
 * have been replaced by a symlink in between. A file that ended up outside the
 * boundary is removed rather than left behind.
 */
function assertStillInsideBoundary(path, boundary) {
    let real;
    let realBoundary;
    try {
        real = realpathSync(path);
        realBoundary = realpathSync(boundary);
    }
    catch {
        // The write itself failed, or the boundary is gone; the caller's own error
        // is the one worth reporting.
        return;
    }
    const root = realBoundary.endsWith(sep) ? realBoundary.slice(0, -1) : realBoundary;
    if (real === root || real.startsWith(root + sep))
        return;
    try {
        unlinkSync(path);
    }
    catch {
        // Already gone, or not ours to remove; the refusal below is what matters.
    }
    throw new Error(`save_run_code_script refused to write outside ${boundary} and removed the file: ${path}`);
}
function scriptTarget(environment, scope) {
    if (scope === 'user')
        return environment.user;
    if (!environment.project) {
        // There is no project-level directory here, either because this is the
        // default workspace or because the project directory is the user one. The
        // only remaining scope is "user", which every project can use, so the
        // wording asks for the user's agreement instead of pointing at a scope
        // that would silently widen where the script lands.
        throw new Error('save_run_code_script: this session has no project-level script directory. Scope "user" makes the script available in every project, so ask the user in the conversation first and save there only after they agree. A subagent that cannot ask the user does not save the script.');
    }
    return environment.project;
}
/**
 * Puts the description on the first line, replacing one the content already
 * has. Without a description the content is saved exactly as it came. The line
 * is normalized, never escaped: the file is source, and the renderers escape
 * what they show.
 */
export function withDescriptionHeader(content, description) {
    if (description === undefined)
        return content;
    const line = `${PTC_SCRIPT_DESCRIPTION_PREFIX} ${ptcScriptSingleLine(description)}`;
    const { end } = ptcScriptFirstLine(content);
    // A first line that is a header is replaced, including one that says nothing;
    // any other first line stays and gains the header above it.
    if (ptcScriptDescriptionFromFirstLine(content) !== undefined) {
        return end === -1 ? line : `${line}${content.slice(end)}`;
    }
    return `${line}\n${content}`;
}
/**
 * Moves the finished temporary file onto the target. A new script is published
 * with `link`, which creates the target or fails and never replaces whatever
 * appeared there since the existence check; an overwrite uses `rename`. The
 * temporary file is removed either way, so a refused or failed publish leaves
 * no `.<name>.<uuid>.tmp` behind.
 *
 * `requestedOverwrite` only changes what a lost race says: the model already
 * asked to replace the file, so telling it to pass `overwrite: true` would
 * send it round the same loop.
 */
function publishScript(temporary, path, overwrite, requestedOverwrite) {
    if (overwrite) {
        try {
            renameSync(temporary, path);
        }
        catch (error) {
            removeQuietly(temporary);
            throw error;
        }
        return;
    }
    try {
        linkSync(temporary, path);
    }
    catch (error) {
        if (isAlreadyExists(error)) {
            removeQuietly(temporary);
            throw existsError(path, requestedOverwrite);
        }
        // A volume that cannot hard-link (exFAT, some network and container
        // filesystems) fails the whole save otherwise. `COPYFILE_EXCL` keeps the
        // same guarantee: it creates the target or fails, and never replaces a file
        // that appeared there since the existence check.
        if (!isUnsupportedLink(error)) {
            removeQuietly(temporary);
            throw error;
        }
        try {
            copyFileSync(temporary, path, constants.COPYFILE_EXCL);
        }
        catch (copyError) {
            removeQuietly(temporary);
            if (isAlreadyExists(copyError))
                throw existsError(path, requestedOverwrite);
            throw copyError;
        }
    }
    removeQuietly(temporary);
}
/** A file that appeared at the target after the existence check. */
function existsError(path, requestedOverwrite) {
    return new PtcScriptExistsError(requestedOverwrite
        ? `save_run_code_script: ${path} was created by another writer after this save checked it, so nothing was written. Retry the save to replace it.`
        : `save_run_code_script: ${path} already exists. Pass overwrite: true to replace it, after asking the user when you did not write it in this conversation.`);
}
function isAlreadyExists(error) {
    return error?.code === 'EEXIST';
}
/** Hard links are unavailable here; the copy below is the same guarantee. */
function isUnsupportedLink(error) {
    const code = error?.code;
    return code === 'ENOTSUP' || code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS';
}
/** The target is already published; a temporary file left behind is harmless. */
function removeQuietly(path) {
    try {
        unlinkSync(path);
    }
    catch {
        // Already gone, or not ours to remove.
    }
}
/** What sits at the target: nothing, a regular file, or something else. */
function existingScriptKind(path) {
    try {
        // `lstat`, so a symlink is never mistaken for the script it points at.
        return lstatSync(path).isFile() ? 'file' : 'other';
    }
    catch {
        return 'none';
    }
}
/** Fixed wording: says what to use instead, so the retry does not need a guess. */
function refusedImportMessage(specifier) {
    return `Saved scripts run inside run_code, not Node.js, so they cannot import ${specifier}. Use tools.read, tools.write or tools.bash in the script instead, then save again.`;
}
/**
 * A refused overwrite, told apart from every other refusal by its own code so
 * the save metric can report `exists` instead of a generic `rejected`.
 */
class PtcScriptExistsError extends Error {
    code = PTC_SCRIPT_SAVE_EXISTS_CODE;
}
function saveFailureCode(error) {
    return error instanceof PtcScriptExistsError ? error.code : 'PTC_SCRIPT_SAVE_FAILED';
}
function failedSave(message, code = 'PTC_SCRIPT_SAVE_FAILED') {
    return {
        tool_name: SAVE_PTC_SCRIPT_NAME,
        text: message,
        content: [{ type: 'text', text: message }],
        isError: true,
        details: { code },
    };
}
//# sourceMappingURL=ptc-script-save.js.map