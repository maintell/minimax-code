import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
const MAX_SECRET_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;
const MAC_KEYCHAIN_TIMEOUT_MS = 120000;
const WINDOWS_DPAPI_TIMEOUT_MS = 15000;
const WINDOWS_DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$inputText = [Console]::In.ReadToEnd()
$encrypted = [Convert]::FromBase64String($inputText)
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($decrypted))
`;
export class MacSafeStorageAccessError extends Error {
    constructor(reason) {
        super(`Chrome Safe Storage access failed: ${reason}`);
        this.name = 'MacSafeStorageAccessError';
        this.reason = reason;
    }
}

function classifySecurityCommandFailure(error, stderr) {
    const normalized = stderr.toLowerCase();
    if (error.code === 'ETIMEDOUT' ||
        (error.killed === true && (error.signal === 'SIGTERM' || error.signal === null))) {
        return 'timeout';
    }
    if (error.code === 44 ||
        normalized.includes('errsecitemnotfound') ||
        normalized.includes('specified item could not be found')) {
        return 'not_found';
    }
    if (error.code === 128 ||
        normalized.includes('user canceled') ||
        normalized.includes('user cancelled') ||
        normalized.includes('authorization denied') ||
        normalized.includes('user interaction is not allowed') ||
        normalized.includes('passphrase you entered is not correct')) {
        return 'denied';
    }
    return 'unavailable';
}
function securityPassword(args, strategy, signal, onLookup) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        onLookup?.({ phase: 'started', strategy });
        execFile('/usr/bin/security', args, {
            encoding: 'utf8',
            maxBuffer: MAX_SECRET_OUTPUT_BYTES,
            timeout: MAC_KEYCHAIN_TIMEOUT_MS,
            signal,
        }, (error, stdout, stderr) => {
            if (error) {
                if (signal?.aborted) {
                    onLookup?.({
                        phase: 'failed',
                        strategy,
                        durationMs: Date.now() - startedAt,
                        reason: 'cancelled',
                    });
                    reject(signal.reason);
                    return;
                }
                const reason = classifySecurityCommandFailure(error, stderr);
                onLookup?.({
                    phase: 'failed',
                    strategy,
                    durationMs: Date.now() - startedAt,
                    reason,
                });
                reject(new MacSafeStorageAccessError(reason));
                return;
            }
            const password = stdout.trim();
            if (!password) {
                onLookup?.({
                    phase: 'failed',
                    strategy,
                    durationMs: Date.now() - startedAt,
                    reason: 'unavailable',
                });
                reject(new MacSafeStorageAccessError('unavailable'));
                return;
            }
            onLookup?.({
                phase: 'completed',
                strategy,
                durationMs: Date.now() - startedAt,
            });
            resolve(password);
        });
    });
}
export async function readMacChromeSafeStoragePassword(signal, onLookup) {
    try {
        return await securityPassword(['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], 'service-and-account', signal, onLookup);
    }
    catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof MacSafeStorageAccessError) || error.reason !== 'not_found')
            throw error;
        return securityPassword(['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], 'service-only', signal, onLookup);
    }
}
function powershellExecutable(environment = process.env) {
    return environment.SystemRoot
        ? path.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
}
export function windowsDpapiUnprotect(encrypted, signal) {
    return new Promise((resolve, reject) => {
        const encodedScript = Buffer.from(WINDOWS_DPAPI_SCRIPT, 'utf16le').toString('base64');
        const child = spawn(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
        const stdout = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (error)
                reject(error);
            else
                resolve(value ?? Buffer.alloc(0));
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(new Error('DPAPI helper timed out'));
        }, WINDOWS_DPAPI_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_SECRET_OUTPUT_BYTES) {
                child.kill();
                finish(new Error('DPAPI output exceeded the size limit'));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on('error', (error) => finish(error));
        child.once('error', (error) => finish(error));
        child.once('close', (code) => {
            if (code !== 0) {
                finish(new Error(`DPAPI helper failed with exit code ${code}`));
                return;
            }
            try {
                finish(undefined, Buffer.from(Buffer.concat(stdout).toString('utf8').trim(), 'base64'));
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        try {
            child.stdin.end(encrypted.toString('base64'));
        }
        catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
export async function readWindowsChromeMasterKey(localStatePath, dpapiUnprotect = windowsDpapiUnprotect, signal) {
    const stats = await lstat(localStatePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_STATE_BYTES) {
        throw new Error('Chrome Local State is not a regular file');
    }
    const localState = JSON.parse(await readFile(localStatePath, 'utf8'));
    const encoded = localState.os_crypt?.encrypted_key;
    if (typeof encoded !== 'string')
        throw new Error('Chrome master key is unavailable');
    const encrypted = Buffer.from(encoded, 'base64');
    if (encrypted.subarray(0, 5).toString('ascii') !== 'DPAPI') {
        throw new Error('Chrome master key does not use DPAPI');
    }
    const masterKey = await (signal
        ? dpapiUnprotect(encrypted.subarray(5), signal)
        : dpapiUnprotect(encrypted.subarray(5)));
    if (masterKey.length !== 32)
        throw new Error('Chrome AES-GCM master key is invalid');
    return masterKey;
}
