import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { createRequire } from "node:module";
// Data directory migration must copy physical files, including user ASAR archives.
// Keep this boundary local: module loading and app assets still use Electron's fs.
// original-fs is an Electron built-in; never fall back to ASAR semantics or toggle
// the process-global noAsar flag around asynchronous migration work.
const physicalFs = process.versions.electron
    ? createRequire(process.execPath)('original-fs')
    : nodeFs;
export let dataDirFs = process.versions.electron ? physicalFs.promises : nodeFsPromises;
export let dataDirFsConstants = physicalFs.constants;
