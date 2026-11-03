import fs from 'node:fs';
import yaml from 'js-yaml';
export class LocalConfigValidationError extends Error {
    name = 'LocalConfigValidationError';
}
export function readLocalRawConfig(configPath) {
    // Callers create missing files before locking. A read failure must abort the
    // update rather than turn an existing configuration into an empty document.
    const source = fs.readFileSync(configPath, 'utf-8');
    let parsed;
    try {
        parsed = yaml.load(source);
    }
    catch {
        // YAML errors include source snippets, which may contain credentials.
        throw new LocalConfigValidationError('Invalid config.yaml: unable to parse YAML');
    }
    if (parsed == null)
        return {};
    if (typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype) {
        throw new LocalConfigValidationError('Invalid config.yaml: expected a YAML mapping');
    }
    return parsed;
}
//# sourceMappingURL=raw-config.js.map