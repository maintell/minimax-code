import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
const execFileAsync = promisify(execFile);
async function macCommand(command, args) {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            encoding: 'utf8',
            timeout: 3000,
            maxBuffer: 64 * 1024,
            env: { ...process.env, LC_ALL: 'C' },
        });
        return { status: 'ok', output: `${stdout}\n${stderr}` };
    }
    catch (error) {
        const failure = error;
        return {
            status: failure?.killed
                ? 'timed_out'
                : failure?.code === 'ENOENT'
                    ? 'unavailable'
                    : 'failed',
            output: '',
        };
    }
}
/** Collected only when feedback is uploaded; never reads browser data or TCC databases. */
export async function collectDesktopEnvironment() {
    const platform = os.platform();
    const common = {
        collectedAt: Date.now(),
        platform,
        kernelRelease: os.release(),
        architecture: os.arch(),
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        processId: process.pid,
        electronVersion: process.versions.electron,
        embeddedChromiumVersion: process.versions.chrome,
        executablePathHash: createHash('sha256').update(process.execPath).digest('hex'),
    };
    if (platform !== 'darwin')
        return common;
    const macos = path.posix;
    const executableDirectory = macos.dirname(process.execPath);
    const contentsDirectory = macos.dirname(executableDirectory);
    const bundlePath = macos.dirname(contentsDirectory);
    const hasBundle = macos.basename(executableDirectory) === 'MacOS' &&
        macos.basename(contentsDirectory) === 'Contents' &&
        bundlePath.endsWith('.app');
    const [version, bundleId, signing, verification] = await Promise.all([
        macCommand('/usr/bin/sw_vers', []),
        ...(hasBundle
            ? [
                macCommand('/usr/bin/plutil', [
                    '-extract',
                    'CFBundleIdentifier',
                    'raw',
                    '-o',
                    '-',
                    macos.join(contentsDirectory, 'Info.plist'),
                ]),
                macCommand('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath]),
                macCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath]),
            ]
            : []),
    ]);
    const identifier = bundleId?.output.trim();
    return {
        ...common,
        macos: {
            versionStatus: version.status,
            productVersion: version.output.match(/^ProductVersion:\s*([\d.]+)\s*$/m)?.[1],
            productVersionExtra: version.output.match(/^ProductVersionExtra:\s*(\([a-z]\))\s*$/m)?.[1],
            buildVersion: version.output.match(/^BuildVersion:\s*([A-Za-z0-9]+)\s*$/m)?.[1],
            bundleStatus: bundleId?.status ?? 'not_in_app_bundle',
            bundleIdentifier: identifier && /^[A-Za-z0-9.-]{1,256}$/.test(identifier) ? identifier : undefined,
            installationLocation: !hasBundle
                ? 'not_in_app_bundle'
                : bundlePath.startsWith('/Applications/')
                    ? 'applications'
                    : bundlePath.startsWith(macos.join(os.homedir(), 'Applications') + '/')
                        ? 'user_applications'
                        : 'other',
            signingStatus: signing?.status ?? 'not_in_app_bundle',
            signingIdentifier: signing?.output.match(/^Identifier=([A-Za-z0-9.-]{1,256})$/m)?.[1],
            teamIdentifier: signing?.output.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1],
            adHocSignature: signing?.status === 'ok' ? /^Signature=adhoc$/m.test(signing.output) : undefined,
            signatureVerification: verification?.status ?? 'not_in_app_bundle',
        },
    };
}
