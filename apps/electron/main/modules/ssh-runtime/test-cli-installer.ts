import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
export function usesSshTestInstaller(buildEnv) {
    return buildEnv === 'dev' || buildEnv === 'test' || buildEnv === 'staging';
}
/** The shipped script resolves the preview channel at installation time. */
export function readSshTestInstaller() {
    const resourcesPath = process.resourcesPath;
    const candidates = [
        ...(resourcesPath ? [path.join(resourcesPath, 'resources', 'install-mcode-test.sh')] : []),
        path.resolve(__dirname, '../../../resources/install-mcode-test.sh'),
        path.resolve(__dirname, '../../../../resources/install-mcode-test.sh'),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file)
        throw new Error('The bundled SSH test installer is missing. Rebuild Desktop.');
    const script = readFileSync(file, 'utf8');
    const packageTag = /^MCODE_TEST_VERSION='(preview)'$/mu.exec(script)?.[1];
    if (!packageTag)
        throw new Error('The SSH test installer must use the preview channel.');
    return { script, packageTag: 'preview' };
}
