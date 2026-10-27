import { HookConfigError } from './errors.js';
import { appendHook, deleteHook, emptyHookDocument, enableOnlyHandler, entryAt, findHookEntry, limitExceededCount, MAX_HOOK_CONFIG_BYTES, normalizeHookDefinition, pairSurvivingEntries, parseHookDocumentValue, replaceHook, serializeHookDocument, setDocumentEnabled, setHandlerEnabled, } from './hook-config-document.js';
import { projectHookLocation, userHookLocation, withHookSettingsLock, writeHookConfigFile, } from './hook-config-files.js';
/** Settings-page management of user and project hook config files. */
export class HookConfigService {
    options;
    source;
    enablement;
    lane = Promise.resolve();
    constructor(options, source, enablement) {
        this.options = options;
        this.source = source;
        this.enablement = enablement;
    }
    async list(ref) {
        const location = await this.locate(ref);
        const version = this.source.ownerVersion(location);
        return this.view(ref, location, await this.source.readScope(location), version);
    }
    async create(ref, expectedRevision, definition) {
        const normalized = normalizeHookDefinition(definition);
        let hookId = '';
        const view = await this.mutate(ref, expectedRevision, async (context) => {
            const base = context.location.scope === 'user' && !context.scopeEnabled
                ? enableOnlyHandler(context.document, context.entries)
                : context.document;
            const next = appendHook(base, normalized);
            const written = await this.writeDocument(context, next.document, next.location);
            hookId = written.hookId;
            await this.carryProjectEnablement(context, written.entries, {
                inserted: next.location,
                ...(context.scopeEnabled ? {} : { enableScope: true }),
            });
        });
        return { ...view, hookId };
    }
    async update(ref, hookId, expectedRevision, definition) {
        const normalized = normalizeHookDefinition(definition);
        let nextHookId = hookId;
        const view = await this.mutate(ref, expectedRevision, async (context) => {
            const entry = findHookEntry(context.entries, hookId);
            const next = replaceHook(context.document, entry, normalized);
            const written = await this.writeDocument(context, next.document, next.location);
            nextHookId = written.hookId;
            await this.carryProjectEnablement(context, written.entries, {
                removed: entry,
                inserted: next.location,
                insertedFrom: hookId,
            });
        });
        return { ...view, hookId: nextHookId };
    }
    delete(ref, hookId, expectedRevision) {
        return this.mutate(ref, expectedRevision, async (context) => {
            const entry = findHookEntry(context.entries, hookId);
            const written = await this.writeDocument(context, deleteHook(context.document, entry));
            await this.carryProjectEnablement(context, written.entries, { removed: entry });
        });
    }
    /**
     * Enabling a hook in a scope that is off turns the scope on with only that
     * hook enabled, so hooks that were not running stay off.
     */
    setHookEnabled(ref, hookId, enabled, expectedRevision) {
        return this.mutate(ref, expectedRevision, async (context) => {
            const entry = findHookEntry(context.entries, hookId);
            const activateScope = enabled && !context.scopeEnabled;
            if (context.location.scope === 'user') {
                await this.writeDocument(context, activateScope
                    ? enableOnlyHandler(context.document, context.entries, entry)
                    : setHandlerEnabled(context.document, entry, enabled));
                return;
            }
            const key = projectKey(context.location);
            if (activateScope) {
                await this.enablement.update(key, {
                    enabled: true,
                    enable: [hookId],
                    disable: context.entries.map((candidate) => candidate.hookId),
                });
                return;
            }
            await this.enablement.update(key, enabled ? { enable: [hookId] } : { disable: [hookId] });
        });
    }
    setScopeEnabled(ref, enabled, expectedRevision) {
        return this.mutate(ref, expectedRevision, async (context) => {
            if (context.location.scope === 'user') {
                await this.writeDocument(context, setDocumentEnabled(context.document, enabled));
                return;
            }
            await this.enablement.update(projectKey(context.location), { enabled });
        });
    }
    async mutate(ref, expectedRevision, operation) {
        return this.serialized(() => withHookSettingsLock(this.options.dataDir, async () => {
            const location = await this.locate(ref);
            const snapshot = await this.source.readScope(location, { fresh: true });
            if (snapshot.read.kind === 'unreadable' || snapshot.parsed?.ok === false) {
                throw new HookConfigError('LOCAL_HOOK_CONFIG_INVALID', 'hooks.json is invalid; fix the file before editing hooks here.');
            }
            const revision = snapshot.read.kind === 'file' ? snapshot.read.revision : '';
            if (expectedRevision !== undefined && expectedRevision !== revision) {
                throw new HookConfigError('LOCAL_HOOK_CONFIG_CONFLICT', 'hooks.json changed since it was loaded; reload and try again.');
            }
            const parsed = snapshot.parsed?.ok ? snapshot.parsed : undefined;
            await operation({
                location,
                snapshot,
                document: parsed?.document ?? emptyHookDocument(),
                entries: parsed?.entries ?? [],
                exists: snapshot.read.kind === 'file',
                scopeEnabled: location.scope === 'user'
                    ? parsed?.enabled === true
                    : (await this.enablement.read(projectKey(location))).enabled,
            });
            return this.view(ref, location, await this.source.readScope(location, { fresh: true }));
        }));
    }
    async writeDocument(context, document, location) {
        const reparsed = parseHookDocumentValue(document);
        if (!reparsed.ok) {
            throw new HookConfigError('LOCAL_HOOK_CONFIG_INVALID', reparsed.message);
        }
        const written = location ? entryAt(reparsed.entries, location) : undefined;
        if (location && !written) {
            throw new HookConfigError('LOCAL_HOOK_NOT_FOUND', 'Hook was not found after the edit.');
        }
        // The limit falls on whichever handlers come last, so also refuse edits
        // that push an existing executable hook out.
        if (written?.errorCode === 'HOOK_HANDLER_LIMIT_EXCEEDED' ||
            limitExceededCount(reparsed.entries) > limitExceededCount(context.entries)) {
            throw new HookConfigError('LOCAL_HOOK_LIMIT_EXCEEDED', 'A config file holds at most 64 hooks.');
        }
        const content = serializeHookDocument(document);
        if (Buffer.byteLength(content) > MAX_HOOK_CONFIG_BYTES) {
            throw new HookConfigError('LOCAL_HOOK_LIMIT_EXCEEDED', 'hooks.json would exceed the 256 KiB limit; the file was left unchanged.');
        }
        await writeHookConfigFile(context.location, content);
        return { hookId: written?.hookId ?? '', entries: reparsed.entries };
    }
    /**
     * Hook ids hash the definition plus its occurrence, so an edit can renumber
     * the surviving duplicates. Moves each local enablement onto the id its
     * entry has after the edit.
     */
    async carryProjectEnablement(context, after, edit) {
        if (context.location.scope !== 'project')
            return;
        const key = projectKey(context.location);
        const current = await this.enablement.read(key);
        const enable = edit.enableScope
            ? []
            : pairSurvivingEntries(context.entries, after, edit)
                .filter(([before]) => current.hooks.has(before.hookId))
                .map(([, next]) => next.hookId);
        const inserted = insertedEnabledId(after, edit, current);
        if (inserted)
            enable.push(inserted);
        const enabled = new Set(enable);
        const disable = [...context.entries, ...after]
            .map((entry) => entry.hookId)
            .filter((hookId) => !enabled.has(hookId));
        await this.enablement.update(key, {
            enable,
            disable,
            ...(edit.enableScope ? { enabled: true } : {}),
        });
    }
    /** `readVersion` marks a plain read; without it the view follows an edit and is authoritative. */
    async view(ref, location, snapshot, readVersion) {
        const parsed = snapshot.parsed?.ok ? snapshot.parsed : undefined;
        const enablement = location.scope === 'project' ? await this.source.readEnablement(location) : undefined;
        const handlers = this.source.effectiveHandlers(snapshot, enablement);
        if (readVersion === undefined)
            this.source.remember(location, handlers, enablement);
        else
            this.source.rememberRead(location, readVersion, handlers, enablement);
        const fileError = snapshotErrorMessage(snapshot);
        const hooks = (parsed?.entries ?? []).map((entry) => configEntryView(location, entry, enablement));
        return {
            config: {
                scope: location.scope,
                ...(ref.projectDir ? { projectDir: ref.projectDir } : {}),
                configPath: location.configPath,
                exists: snapshot.read.kind === 'file',
                revision: snapshot.read.kind === 'file' ? snapshot.read.revision : '',
                enabled: location.scope === 'user' ? Boolean(parsed?.enabled) : Boolean(enablement?.enabled),
                ...(fileError ? { errorCode: 'LOCAL_HOOK_CONFIG_INVALID', errorMessage: fileError } : {}),
            },
            hooks,
        };
    }
    async locate(ref) {
        if (ref.scope === 'user')
            return userHookLocation(this.options.dataDir);
        if (ref.scope === 'project' && ref.projectDir) {
            return projectHookLocation(this.options.dataDir, ref.projectDir);
        }
        throw new HookConfigError('LOCAL_HOOK_SCOPE_INVALID', 'Hook scope or project is missing.');
    }
    async serialized(operation) {
        const previous = this.lane;
        let release = () => undefined;
        this.lane = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
function insertedEnabledId(after, edit, current) {
    const inserted = edit.inserted ? entryAt(after, edit.inserted) : undefined;
    if (!inserted)
        return undefined;
    return edit.insertedFrom === undefined || current.hooks.has(edit.insertedFrom)
        ? inserted.hookId
        : undefined;
}
function snapshotErrorMessage(snapshot) {
    if (snapshot.read.kind === 'unreadable')
        return snapshot.read.message;
    return snapshot.parsed?.ok === false ? snapshot.parsed.message : undefined;
}
function configEntryView(location, entry, enablement) {
    return {
        hookId: entry.hookId,
        source: location.scope,
        definition: entry.definition,
        enabled: location.scope === 'user'
            ? entry.enabledInFile
            : Boolean(enablement?.hooks.has(entry.hookId)),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    };
}
function projectKey(location) {
    return location.projectKey ?? location.root;
}
//# sourceMappingURL=hook-config.service.js.map