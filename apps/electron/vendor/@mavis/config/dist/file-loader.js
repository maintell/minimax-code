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
export function loadConfigFromFile(configPath, options) {
    if (fs.existsSync(configPath))
        prepareConfigFileForRead(configPath);
    return resolveConfigFromRaw(readConfigDocument(configPath), options.dataDir);
}
export function readExplicitBetaFeatureFromFile(configPath, feature) {
    const raw = readConfigDocument(configPath);
    if (raw.beta == null || typeof raw.beta !== 'object' || Array.isArray(raw.beta)) {
        return undefined;
    }
    const configured = raw.beta[feature];
    return typeof configured === 'boolean' ? configured : undefined;
}
//# sourceMappingURL=file-loader.js.map