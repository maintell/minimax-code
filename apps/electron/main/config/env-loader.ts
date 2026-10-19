export function parseEnvFile(content) {
    const result = {};
    content.split('\n').forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            return;
        }
        const match = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            result[key] = value;
        }
    });
    return result;
}
export function isElectronDevelopmentMode(nodeEnv, isPackaged) {
    return !isPackaged && nodeEnv === 'development';
}
const PACKAGED_BUILD_FLAG_KEYS = [
    '__MAVIS_BUILD_INTERNAL',
    '__MAVIS_BUILD_INSIDE',
    'MAVIS_LOCAL_RUNTIME_ISOLATION',
];
export function clearInheritedPackagedBuildFlags(targetEnv) {
    for (const key of PACKAGED_BUILD_FLAG_KEYS) {
        delete targetEnv[key];
    }
}
export function applyEnvVars(envVars, targetEnv, options = {}) {
    const { override = false } = options;
    Object.entries(envVars).forEach(([key, value]) => {
        if (override || targetEnv[key] === undefined) {
            targetEnv[key] = value;
        }
    });
}
