import fs from 'node:fs';
import yaml from 'js-yaml';
import { prepareConfigFileForRead, resolveConfigFromRaw } from './config.js';
export class ConfigFileError extends Error {
    code;
    configPath;
    constructor(code, configPath, message, options) {
        super(message, options);
        this.name = 'ConfigFileError';
        this.code = code;
        this.configPath = configPath;
    }
}
function readConfigDocument(configPath) {
    let text;
    try {
        text = fs.readFileSync(configPath, 'utf-8');
    }
    catch (cause) {
        throw new ConfigFileError('CONFIG_READ_FAILED', configPath, `Cannot read config ${configPath}.`, { cause });
    }
    let parsed;
    try {
        parsed = yaml.load(text);
    }
    catch (cause) {
        throw new ConfigFileError('CONFIG_PARSE_FAILED', configPath, `Config is not valid YAML: ${configPath}`, { cause });
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigFileError('CONFIG_ROOT_INVALID', configPath, `Config root must be an object: ${configPath}`);
    }
    return parsed;
}
/**
 * Loads a config file by path. Unreadable, malformed or non-mapping files always
 * throw. An invalid section falls back like getConfig() unless the caller asks
 * for `invalidSections: 'reject'`.
 */
export function loadConfigFromFile(configPath, options) {
    if (fs.existsSync(configPath))
        prepareConfigFileForRead(configPath);
    const config = resolveConfigFromRaw(readConfigDocument(configPath), options.dataDir);
    const invalid = config.configIssues.filter((issue) => issue.kind === 'invalid_section');
    if (invalid.length > 0 && options.invalidSections === 'reject') {
        throw new ConfigFileError('CONFIG_SECTION_INVALID', configPath, `Config has invalid settings: ${configPath} (${invalid
            .map((issue) => `${issue.section ?? 'config'}: ${issue.message}`)
            .join('; ')})`);
    }
    return config;
}
export function readExplicitBetaFeatureFromFile(configPath, feature) {
    const raw = readConfigDocument(configPath);
    if (raw.beta == null || typeof raw.beta !== 'object' || Array.isArray(raw.beta)) {
        return undefined;
    }
    const configured = raw.beta[feature];
    return typeof configured === 'boolean' ? configured : undefined;
}
/** The environment opt-out applies to all three interactive TUI upload channels. */
export function resolveTuiTelemetryPolicy(configPath, environment = process.env) {
    for (const name of ['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK']) {
        if (/^(?:1|true|yes|on)$/iu.test(environment[name]?.trim() ?? '')) {
            return { usageEnabled: false, diagnosticUploadsEnabled: false };
        }
    }
    let usageEnabled = false;
    try {
        const { telemetry } = readConfigDocument(configPath);
        usageEnabled =
            telemetry != null &&
                typeof telemetry === 'object' &&
                Object.hasOwn(telemetry, 'enabled') &&
                telemetry.enabled === true;
    }
    catch {
        // Missing or malformed config isn't consent to collect usage events.
    }
    return { usageEnabled, diagnosticUploadsEnabled: true };
}
//# sourceMappingURL=file-loader.js.map