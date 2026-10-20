import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { logger } from '../common/logger.js';
import { configV1ToRules, configV2ToRules, mutateRules, readPermissionUpdate, readRuleSource, readRuleStringArray, rulesToConfigV1, rulesToConfigV2, } from './rule-codec.js';
import { selectMatchingRule } from './rule-match.js';
import { LocalPermissionRuleError, LocalPermissionStoreUnhealthyError, } from './rule-model.js';
export { serializeLocalPermissionRule } from './rule-codec.js';
export { LocalPermissionRuleError, LocalPermissionStoreUnhealthyError } from './rule-model.js';
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^[a-z0-9_-]+$/i;
export class LocalPermissionRuleStore {
    dataDirGetter;
    metricsClient;
    storageWriteVersionGetter;
    /** Per-file promise chain serializing read-modify-write cycles. */
    writeQueues = new Map();
    constructor(dataDirGetter, metricsClient, storageWriteVersionGetter = () => 2) {
        this.dataDirGetter = dataDirGetter;
        this.metricsClient = metricsClient;
        this.storageWriteVersionGetter = storageWriteVersionGetter;
    }
    async listRules(filter = {}) {
        const source = filter.source ? readRuleSource(filter.source) : undefined;
        const agentName = filter.agentName ?? undefined;
        const agentNames = filter.agentNames
            ? [...new Set(filter.agentNames)]
            : agentName
                ? [agentName]
                : [];
        const sessionId = filter.sessionId ?? undefined;
        for (const name of agentNames)
            validateAgentName(name);
        if (sessionId)
            validateSessionId(sessionId);
        const rules = [
            ...(await this.readRules('global', 'global')),
            ...(await Promise.all(agentNames.map((name) => this.readRules('agent', name)))).flat(),
            ...(sessionId ? await this.readRules('session', sessionId) : []),
        ];
        return source ? rules.filter((rule) => rule.source === source) : rules;
    }
    async applyUpdate(raw) {
        const update = readPermissionUpdate(raw);
        // Serialize the whole read-modify-write per file: concurrent updates
        // (e.g. bulk permission batch-reply from parallel agents) would otherwise
        // lose rules or tear the file (issue minimax-code#117).
        const filePath = this.filePath(update.source, update.destination);
        logger.info({
            lifecycle: 'rule_update_start',
            update_type: update.type,
            source: update.source,
            destination_kind: update.source === 'global' ? 'global' : update.source,
            rule_count: update.rules.length,
        }, 'permission.store');
        await this.withFileQueue(filePath, async () => {
            const current = await this.readConfigFile(filePath, update.source, update.destination);
            const next = mutateRules(current.rules, update);
            await this.writeRules(filePath, next, this.readStorageWriteVersion());
        });
        logger.info({
            lifecycle: 'rule_update_committed',
            update_type: update.type,
            source: update.source,
            destination_kind: update.source === 'global' ? 'global' : update.source,
            rule_count: update.rules.length,
        }, 'permission.store');
    }
    async deleteSession(sessionId) {
        const filePath = this.filePath('session', sessionId);
        await this.withFileQueue(filePath, () => rm(filePath, { force: true }));
    }
    async copySession(sourceSessionId, targetSessionId) {
        validateSessionId(sourceSessionId);
        validateSessionId(targetSessionId);
        const sourceState = await this.readConfigFile(this.filePath('session', sourceSessionId), 'session', sourceSessionId);
        const sourceRules = sourceState.rules;
        const targetPath = this.filePath('session', targetSessionId);
        await this.withFileQueue(targetPath, () => {
            if (sourceRules.length === 0)
                return rm(targetPath, { force: true });
            return this.writeRules(targetPath, sourceRules.map((rule) => ({ ...rule, destination: targetSessionId })), this.readStorageWriteVersion());
        });
    }
    /**
     * Startup snapshot for a trusted child execution, not a grant or a fork.
     * Merge only parent Session restrictions; never replace the child's rules.
     * Read/lock/write failures propagate so the caller can stop before its first Turn.
     */
    async inheritSessionRestrictions(sourceSessionId, targetSessionId) {
        validateSessionId(sourceSessionId);
        validateSessionId(targetSessionId);
        const source = await this.readConfigFile(this.filePath('session', sourceSessionId), 'session', sourceSessionId, true);
        const targetPath = this.filePath('session', targetSessionId);
        await this.withFileQueue(targetPath, async () => {
            const current = await this.readConfigFile(targetPath, 'session', targetSessionId, true);
            let next = current.rules;
            for (const behavior of ['deny', 'ask']) {
                next = mutateRules(next, {
                    type: 'addRules',
                    source: 'session',
                    destination: targetSessionId,
                    behavior,
                    rules: source.rules
                        .filter((rule) => rule.ruleBehavior === behavior)
                        .map((rule) => rule.ruleValue),
                });
            }
            if (next.length === current.rules.length)
                return;
            const writeVersion = this.readStorageWriteVersion();
            if (writeVersion === 1) {
                // The rollback writer may erase action/matcher semantics. This trusted
                // preparation must fail closed instead of widening existing child rules.
                const projected = configV1ToRules(rulesToConfigV1(next), 'session', targetSessionId);
                const comparisons = [
                    [next, projected],
                    [projected, next],
                ];
                for (const behavior of ['allow', 'deny', 'ask']) {
                    for (const [original, comparison] of comparisons) {
                        if (mutateRules(original, {
                            type: 'addRules',
                            source: 'session',
                            destination: targetSessionId,
                            behavior,
                            rules: comparison
                                .filter((rule) => rule.ruleBehavior === behavior)
                                .map((rule) => rule.ruleValue),
                        }).length !== original.length) {
                            throw new LocalPermissionRuleError('Cannot preserve Session permission restrictions with the v1 permission writer.', 503);
                        }
                    }
                }
            }
            await this.writeRules(targetPath, next, writeVersion);
        });
    }
    async check(input) {
        if (input.mode === 'off') {
            return {
                behavior: 'allow',
                reason: `Permission mode ${input.mode} allows local tool calls.`,
            };
        }
        const rules = await this.listRules({
            agentName: input.agentName,
            sessionId: input.sessionId,
        });
        const match = selectMatchingRule(rules, input.toolName, input.input);
        if (input.mode === 'bypassPermissions') {
            if (match && match.ruleBehavior !== 'allow') {
                return {
                    behavior: match.ruleBehavior,
                    reason: `Matched ${match.source} permission rule for ${input.toolName}.`,
                    rule: match,
                };
            }
            return {
                behavior: 'allow',
                reason: `Permission mode ${input.mode} allows local tool calls.`,
            };
        }
        if (match) {
            return {
                behavior: match.ruleBehavior,
                reason: `Matched ${match.source} permission rule for ${input.toolName}.`,
                rule: match,
            };
        }
        return {
            behavior: 'ask',
            reason: `No local permission rule matched ${input.toolName}; approval is required.`,
        };
    }
    async readRules(source, destination) {
        const state = await this.readConfigFile(this.filePath(source, destination), source, destination);
        return state.rules;
    }
    async readConfigFile(filePath, source, destination, strictLegacyShape = false) {
        let text;
        try {
            text = await readFile(filePath, 'utf-8');
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return { rules: [] };
            throw err;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            // Keep the corrupt file in place as repair evidence. Treating it as an
            // empty rule set could drop a persisted deny and silently authorize a
            // command; callers map this typed health failure to an approval prompt.
            logger.warn({ lifecycle: 'store_unhealthy', source, reason: 'corrupt-json' }, 'permission.store');
            this.metricsClient?.counter('permission_store_corrupt_total', 1, { source });
            throw new LocalPermissionStoreUnhealthyError('corrupt-json', source);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            logger.warn({ lifecycle: 'store_unhealthy', source, reason: 'invalid-store-shape' }, 'permission.store');
            throw new LocalPermissionStoreUnhealthyError('invalid-store-shape', source);
        }
        const record = parsed;
        if (record.version === 2) {
            try {
                return {
                    rules: configV2ToRules(record, source, destination),
                };
            }
            catch (error) {
                logger.warn({
                    lifecycle: 'store_unhealthy',
                    source,
                    reason: 'invalid-v2-rule',
                    error: error instanceof Error ? error.message : String(error),
                }, 'permission.store');
                throw new LocalPermissionStoreUnhealthyError('invalid-v2-rule', source);
            }
        }
        if (record.version !== undefined) {
            logger.warn({ lifecycle: 'unsupported_store_version', source, version: record.version }, 'permission.store');
            throw new LocalPermissionStoreUnhealthyError('unsupported-version', source);
        }
        if (strictLegacyShape &&
            ['allow', 'deny', 'ask'].some((behavior) => {
                const values = record[behavior];
                return (values !== undefined &&
                    (!Array.isArray(values) ||
                        values.some((value) => typeof value !== 'string' || !value.trim())));
            })) {
            // Legacy management reads remain compatible; child initialization must
            // not interpret malformed restrictions as an empty snapshot.
            throw new LocalPermissionStoreUnhealthyError('invalid-store-shape', source);
        }
        const config = {
            allow: readRuleStringArray(record.allow),
            deny: readRuleStringArray(record.deny),
            ask: readRuleStringArray(record.ask),
        };
        return { rules: configV1ToRules(config, source, destination) };
    }
    async writeRules(filePath, rules, writeVersion) {
        await mkdir(path.dirname(filePath), { recursive: true });
        // Atomic replace (temp file + rename) so a crash or a concurrent reader
        // never observes a torn permission store.
        const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        const config = writeVersion === 2 ? rulesToConfigV2(rules) : rulesToConfigV1(rules);
        try {
            await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
            await rename(tmp, filePath);
        }
        catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined);
            throw error;
        }
    }
    readStorageWriteVersion() {
        return this.storageWriteVersionGetter() === 2 ? 2 : 1;
    }
    async withFileQueue(filePath, work) {
        const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => this.withCrossProcessFileLock(filePath, work));
        this.writeQueues.set(filePath, next.catch(() => undefined));
        return next;
    }
    async withCrossProcessFileLock(filePath, work) {
        await mkdir(path.dirname(filePath), { recursive: true });
        let release;
        try {
            // `realpath: false` allows locking a permission file before its first
            // write. proper-lockfile creates a same-directory lock directory, so
            // every runtime sharing this dataDir serializes the full read-modify-write.
            release = await lockfile.lock(filePath, {
                realpath: false,
                stale: 10_000,
                retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
            });
            return await work();
        }
        finally {
            await release?.().catch(() => undefined);
        }
    }
    filePath(source, destination) {
        const dataDir = this.dataDirGetter();
        if (source === 'global') {
            if (destination !== 'global') {
                throw new LocalPermissionRuleError('Global permission updates must use destination "global"');
            }
            return path.join(dataDir, 'permission.json');
        }
        if (source === 'agent') {
            validateAgentName(destination);
            return resolveScopedPermissionPath(dataDir, 'agents', destination);
        }
        validateSessionId(destination);
        return resolveScopedPermissionPath(dataDir, 'sessions', destination);
    }
}
function resolveScopedPermissionPath(dataDir, scopeDir, destination) {
    const scopeRoot = path.resolve(dataDir, scopeDir);
    const resolved = path.resolve(scopeRoot, destination, 'permission.json');
    if (!resolved.startsWith(`${scopeRoot}${path.sep}`)) {
        throw new LocalPermissionRuleError(`Invalid permission destination: ${destination}`);
    }
    return resolved;
}
function validateAgentName(agentName) {
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new LocalPermissionRuleError(`Invalid agent name: "${agentName}"`);
    }
}
function validateSessionId(sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw new LocalPermissionRuleError(`Invalid session id: "${sessionId}"`);
    }
}
//# sourceMappingURL=rules.js.map