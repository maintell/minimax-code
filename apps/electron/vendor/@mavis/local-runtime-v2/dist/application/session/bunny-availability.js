import { isBunnyEnabledInConfig } from '@mavis/config';
import { composeBunnyWithMemory } from './bunny-memory-composition.js';
import { startupRecoveryControls } from './runtime-services-lifecycle.js';
/**
 * Bunny for this run, or Bunny turned off when its store could not be opened.
 *
 * The store opens here, before Bunny is composed, when Bunny is on or the store already holds
 * data; otherwise (Bunny off and nothing stored, the production default) it stays closed and
 * the file is not created until Bunny is turned on and first used. Bunny's startup steps that
 * read the store skip a store that holds nothing.
 *
 * Turned off, no Bunny owner exists: its routes are not mounted and fall through to the v1
 * host, which refuses them; the runtime gets ready through the MiniApp owners alone and closes
 * the other owners as usual. Bunny's late-bound ports stay unbound, so a leftover Bunny
 * session's tool calls ask the user instead of following Bunny's permission mode. A store that
 * first fails later in the run is refused by the Bunny routes themselves with 503.
 */
export function composeBunnyUnlessUnavailable(...args) {
    const [input, , close] = args;
    const store = input.options.bunnyStore;
    if (isBunnyEnabledInConfig(input.product.preparation.configBuilder.config()) || store.hasData())
        store.open();
    if (store.unavailable === undefined)
        return composeBunnyWithMemory(...args);
    return {
        services: {},
        ready: () => input.owners.miniAppComposition.ready(),
        // Assignment tasks live in the Bunny store; an unavailable store has none to recover.
        recoverAssignments: async () => undefined,
        recovery: (lifecycle, beginClose) => startupRecoveryControls(lifecycle, close, beginClose),
    };
}
/** Runtime options as the Bunny composition takes them, with the late-bound Bunny ports. */
export function bunnyCompositionOptions(options, lateBunny) {
    const { backgroundTasks } = options.prepared;
    return {
        ...options,
        userInputTurns: lateBunny.userInputTurns,
        mayCoordinate: lateBunny.mayCoordinate,
        backgroundTasks: backgroundTasks.service,
        bindClosedTaskBackgroundRoute: (route) => backgroundTasks.bindClosedTaskRoute(route),
    };
}
//# sourceMappingURL=bunny-availability.js.map