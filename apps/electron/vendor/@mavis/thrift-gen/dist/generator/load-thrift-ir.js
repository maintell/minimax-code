import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_SERVICE_IDL_RELATIVE_PATH } from './idl-source.js';
export async function loadThriftIr(options) {
    const packageRoot = options.packageRoot ?? findPackageRoot();
    const helperDir = join(packageRoot, 'native/thrift-ast');
    const entryPath = options.entryPath ?? DESKTOP_SERVICE_IDL_RELATIVE_PATH;
    const stdout = await runCommand(options.goBinary ?? 'go', ['run', '.', '--idl-dir', resolve(options.idlDir), '--entry', entryPath], helperDir);
    return parseThriftIrJson(stdout);
}
export function parseThriftIrJson(payload) {
    const parsed = JSON.parse(payload);
    if (parsed.irVersion !== 2) {
        throw new Error(`Unsupported thrift IR version ${String(parsed.irVersion)}`);
    }
    if (!parsed.source?.entry || !parsed.source.idlDir) {
        throw new Error('Invalid thrift IR: missing source entry or idlDir');
    }
    if (!Array.isArray(parsed.files)) {
        throw new Error('Invalid thrift IR: missing files');
    }
    for (const file of parsed.files) {
        if (!file.path ||
            !file.namespaces ||
            !Array.isArray(file.includes) ||
            !Array.isArray(file.typedefs) ||
            !Array.isArray(file.enums) ||
            !Array.isArray(file.structs) ||
            !Array.isArray(file.services)) {
            throw new Error(`Invalid thrift IR: malformed file ${String(file.path)}`);
        }
    }
    return parsed;
}
function findPackageRoot() {
    let current = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(current, 'native/thrift-ast/go.mod'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new Error('Unable to locate @mavis/thrift-gen package root from generator module');
        }
        current = parent;
    }
}
async function runCommand(command, args, cwd) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolvePromise(stdout);
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`));
        });
    });
}
//# sourceMappingURL=load-thrift-ir.js.map