import { pathToFileURL } from "node:url";
import { importEsm } from "../../../utils/import-esm.js";
/** Load the transport from Main's dependencies, regardless of a dynamic import's referrer. */
export async function importRuntimeTransportModule() {
    // Keep Vitest's mocked module namespace. The native CJS path is exercised in
    // a separate process by runtime-transport-module.test.ts.
    const specifier = process.env.VITEST === 'true'
        ? '@mavis/shared/runtime-transport'
        : pathToFileURL(require.resolve('@mavis/shared/runtime-transport')).href;
    // Identical new Function import bodies can share another module's referrer.
    // An absolute URL cannot be re-resolved against that unrelated package.
    // This export has a default condition; import-only exports need ESM resolution.
    return importEsm(specifier);
}
