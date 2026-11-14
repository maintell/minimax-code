import { DEFAULT_AGENT_SURFACE_FLAGS, } from '../../contracts.js';
import { canonicalBuiltinName } from '../../builtin/definitions.js';
import { parseExplicitNameOrStable } from '../../domain/names.js';
import { AgentConfigError, } from '../../storage/canonical-agent-config.js';
/**
 * Reads an Agent's surface / dispatch switches from its **current** canonical
 * `agent.md` on every call.
 *
 * Deliberately uncached, and deliberately not read from the bundled built-in
 * definition: the canonical file is what a user can edit while the runtime is
 * live, so an edit applies from the next read without a restart, and the next
 * startup restores the bundled Builtin preset (see builtin-canonical-files.ts,
 * which rewrites the file on every launch).
 *
 * This is the opposite of the capability rule, where the shipped definition is
 * authoritative and the rebuilt file is only an audit mirror: these three
 * switches are product surface policy the user is expected to be able to
 * override per Agent.
 *
 * Any `AgentConfigError` keeps the wire defaults so one broken Agent file
 * cannot hide it or change dispatch behaviour. That includes a directory-level
 * read failure (EACCES/EIO), which the canonical codec wraps into
 * `AGENT_CONFIG_INVALID` rather than letting it escape: the worst case is the
 * behaviour from before these switches existed. Anything that is not an
 * `AgentConfigError` still propagates.
 */
async function readAgentSurfaceFlags(repository, name, options) {
    try {
        const config = options.builtin
            ? await repository.getBuiltinCanonicalConfig?.(name)
            : await repository.getCanonicalConfig?.(name);
        return surfaceFlagsFromMavis(config?.xMavis);
    }
    catch (error) {
        if (error instanceof AgentConfigError)
            return DEFAULT_AGENT_SURFACE_FLAGS;
        throw error;
    }
}
/**
 * Owner-level read: resolves which file holds the switches (the `.builtin`
 * mirror for a built-in, the Custom file otherwise) from the persisted row,
 * then reads it. The Agent service keeps only this one call per site so its
 * own module stays inside the service line budget.
 *
 * The row is looked up by the **exact physical owner name**, and only the file
 * name is canonicalised. An upgraded install can still store its primary Agent
 * under the legacy `main` row with no `mavis` row at all; looking that owner up
 * by its canonical view name would miss the row, fall through to the Custom
 * file (which the primary-family guard refuses to read) and silently return the
 * defaults. Its switches do live in `.builtin/mavis/agent.md`, because startup
 * deletes the retired `.builtin/main/agent.md`
 * (see builtin-canonical-files.ts), so a built-in always reads its canonical
 * file name.
 */
export async function readOwnerSurfaceFlags(repository, exactOwnerName, isBuiltin) {
    const meta = await repository.get(exactOwnerName);
    const builtin = meta !== undefined && isBuiltin(meta);
    return readAgentSurfaceFlags(repository, builtin ? canonicalBuiltinName(exactOwnerName) : exactOwnerName, { builtin });
}
/**
 * Task-tool dispatch fact for one request reference. Only the task tool calls
 * it; every other session-creating flow is unaffected.
 */
export async function readOwnerDispatchable(repository, requestRef, isBuiltin) {
    const exact = parseExplicitNameOrStable(requestRef);
    return (await readOwnerSurfaceFlags(repository, exact, isBuiltin)).dispatchable;
}
/** Every switch defaults to true, matching the `x-mavis` contract. */
function surfaceFlagsFromMavis(mavis) {
    return {
        showInImBinding: mavis?.showInImBinding ?? DEFAULT_AGENT_SURFACE_FLAGS.showInImBinding,
        showInAgentList: mavis?.showInAgentList ?? DEFAULT_AGENT_SURFACE_FLAGS.showInAgentList,
        dispatchable: mavis?.dispatchable ?? DEFAULT_AGENT_SURFACE_FLAGS.dispatchable,
    };
}
//# sourceMappingURL=surface-flags.js.map