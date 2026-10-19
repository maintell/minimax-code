import { execFile } from "node:child_process";
import path from "node:path";
export async function prepareDevelopmentMcodeToolsResource(options, dependencies = { execFile: defaultExecFile }) {
    const resourceDir = path.join(options.dataDir, 'integrations', 'mcode-tools', 'resource');
    const helperPath = path.join(options.appPath, 'scripts', 'mcode-tools-dev-resource.mjs');
    try {
        await dependencies.execFile(options.executable, [helperPath, '--resource-dir', resourceDir], {
            encoding: 'utf8',
            env: buildHelperEnv(options.parentEnv),
            maxBuffer: 1024 * 1024,
            timeout: 120000,
            windowsHide: true,
        });
    }
    catch {
        throw new Error('mcode-tools development resource preparation failed');
    }
    return resourceDir;
}
function buildHelperEnv(parentEnv) {
    const env = { ...parentEnv, ELECTRON_RUN_AS_NODE: '1' };
    delete env.MAVIS_ACCESS_TOKEN;
    for (const key of Object.keys(env)) {
        const normalized = key.toUpperCase();
        if (normalized.startsWith('__MAVIS_PARENT_') ||
            normalized.startsWith('__MAVIS_RUNTIME_') ||
            normalized.startsWith('AGENTARCHON_') ||
            normalized.startsWith('AGENT_ARCHON_')) {
            delete env[key];
        }
    }
    return env;
}
function defaultExecFile(executable, args, options) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
