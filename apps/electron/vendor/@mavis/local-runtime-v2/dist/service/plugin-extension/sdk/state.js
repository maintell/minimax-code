/**
 * Declares plugin state at module top level. The argument must be an object literal so validate
 * can derive `PluginState` (`EXTENSION_STATE_SHAPE_INVALID` otherwise). Storage is provided by
 * the host; this function only returns the declaration.
 */
export function defineState(spec) {
    return Object.freeze({ spec: Object.freeze({ ...spec }) });
}
//# sourceMappingURL=state.js.map