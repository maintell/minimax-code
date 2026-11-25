/**
 * `@minimax/mcode-plugin-extension/testing`: write `*.test.tsx` next to the module and run them
 * with the agent tool action `extension test`. The host serves this specifier with an instance
 * bound to its realm, dispatcher and validator; outside the host `mount` rejects.
 */
import { createExtensionTesting } from '../testing/harness.js';
const outsideHost = {
    mount: () => Promise.reject(new Error('Extension tests run inside the extension host: use the `extension test` action.')),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const standalone = createExtensionTesting(outsideHost);
export const { mount, find, findAll, press, waitFor, completeAgent, unmount, test, expect } = standalone;
//# sourceMappingURL=testing.js.map