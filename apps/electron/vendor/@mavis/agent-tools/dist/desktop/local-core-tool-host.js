import { homedir } from 'node:os';
import { physicalToolFs } from '../shared/physical-fs.js';
import { runRg } from './local-rg-runner.js';
/** Desktop host of the core tools: the physical filesystem, bundled ripgrep and the OS home. */
export const localCoreToolHost = {
    fs: physicalToolFs,
    runRg,
    homedir: () => homedir(),
};
//# sourceMappingURL=local-core-tool-host.js.map