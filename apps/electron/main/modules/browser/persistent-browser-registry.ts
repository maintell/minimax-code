import { randomUUID } from "node:crypto";
const REGISTRY_VERSION = 2;
const DEFAULT_PERSIST_DELAY_MS = 200;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 512;
export let MAX_PERSISTED_BROWSER_HISTORY_ENTRIES = 50;
export let MAX_PERSISTED_BROWSER_SESSIONS = 50;
export let MAX_PERSISTED_BROWSER_TABS_PER_SESSION = 10;
const memoryStorage = () => {
    let value;
    return {
        read: () => value,
        write: (next) => {
            value = structuredClone(next);
        },
        clear: () => {
            value = undefined;
        },
    };
};
function normalizeSessionId(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    return normalized && normalized.length <= MAX_SESSION_ID_LENGTH ? normalized : null;
}
function normalizePersistentTabId(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    return normalized && normalized.length <= 128 ? normalized : null;
}
function normalizeTitle(value) {
    return typeof value === 'string' ? value.slice(0, MAX_TITLE_LENGTH) : '';
}
function normalizeTimestamp(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function normalizePersistedBrowserUrl(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_URL_LENGTH)
        return null;
    if (normalized === 'about:blank')
        return normalized;
    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' &&
            parsed.protocol !== 'https:' &&
            parsed.protocol !== 'file:') {
            return null;
        }
        return parsed.href;
    }
    catch {
        return null;
    }
}
function cloneSession(session) {
    return {
        ...session,
        tabs: session.tabs.map((tab) => ({
            ...tab,
            ...(tab.navigationHistory
                ? {
                    navigationHistory: {
                        activeIndex: tab.navigationHistory.activeIndex,
                        entries: tab.navigationHistory.entries.map((entry) => ({ ...entry })),
                    },
                }
                : {}),
        })),
    };
}
function normalizeNavigationHistory(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    if (!Array.isArray(raw.entries))
        return undefined;
    const normalizedEntries = [];
    for (const [originalIndex, rawEntry] of raw.entries.entries()) {
        if (!rawEntry || typeof rawEntry !== 'object')
            continue;
        const candidate = rawEntry;
        const url = normalizePersistedBrowserUrl(candidate.url);
        if (!url)
            continue;
        normalizedEntries.push({
            entry: { url, title: normalizeTitle(candidate.title) },
            originalIndex,
        });
    }
    if (normalizedEntries.length === 0)
        return undefined;
    const requestedIndex = typeof raw.activeIndex === 'number' && Number.isFinite(raw.activeIndex)
        ? Math.floor(raw.activeIndex)
        : raw.entries.length - 1;
    const boundedOriginalIndex = Math.max(0, Math.min(raw.entries.length - 1, requestedIndex));
    let boundedRequestedIndex = 0;
    for (const [normalizedIndex, candidate] of normalizedEntries.entries()) {
        if (candidate.originalIndex > boundedOriginalIndex)
            break;
        boundedRequestedIndex = normalizedIndex;
    }
    const start = Math.min(Math.max(0, boundedRequestedIndex - Math.floor(MAX_PERSISTED_BROWSER_HISTORY_ENTRIES / 2)), Math.max(0, normalizedEntries.length - MAX_PERSISTED_BROWSER_HISTORY_ENTRIES));
    const entries = normalizedEntries
        .slice(start, start + MAX_PERSISTED_BROWSER_HISTORY_ENTRIES)
        .map(({ entry }) => entry);
    return {
        entries,
        activeIndex: boundedRequestedIndex - start,
    };
}
function normalizeTab(value, now) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    const persistentTabId = normalizePersistentTabId(raw.persistentTabId);
    const url = normalizePersistedBrowserUrl(raw.url);
    if (!persistentTabId || !url)
        return null;
    const createdAt = normalizeTimestamp(raw.createdAt, now);
    const navigationHistory = normalizeNavigationHistory(raw.navigationHistory);
    const requestedUrl = normalizePersistedBrowserUrl(raw.requestedUrl);
    return {
        persistentTabId,
        url,
        ...(requestedUrl ? { requestedUrl } : {}),
        title: normalizeTitle(raw.title),
        order: typeof raw.order === 'number' && Number.isFinite(raw.order) && raw.order >= 0
            ? Math.floor(raw.order)
            : 0,
        createdAt,
        lastActiveAt: normalizeTimestamp(raw.lastActiveAt, createdAt),
        ...(navigationHistory ? { navigationHistory } : {}),
    };
}
function normalizeSession(value, now) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    const sessionId = normalizeSessionId(raw.sessionId);
    if (!sessionId || !Array.isArray(raw.tabs))
        return null;
    const tabs = raw.tabs
        .map((tab) => normalizeTab(tab, now))
        .filter((tab) => tab !== null)
        .sort((left, right) => left.order - right.order)
        .slice(-MAX_PERSISTED_BROWSER_TABS_PER_SESSION)
        .map((tab, order) => ({ ...tab, order }));
    if (tabs.length === 0)
        return null;
    const requestedSelectedId = normalizePersistentTabId(raw.selectedPersistentTabId);
    const selectedPersistentTabId = tabs.some((tab) => tab.persistentTabId === requestedSelectedId)
        ? requestedSelectedId
        : (tabs[tabs.length - 1]?.persistentTabId ?? null);
    const createdAt = normalizeTimestamp(raw.createdAt, now);
    return {
        sessionId,
        selectedPersistentTabId,
        tabs,
        createdAt,
        updatedAt: normalizeTimestamp(raw.updatedAt, createdAt),
    };
}
export class PersistentBrowserRegistry {
    constructor(options = {}) {
        this.persistTimer = null;
        this.dirty = false;
        this.storage = options.storage ?? memoryStorage();
        this.now = options.now ?? Date.now;
        this.createId = options.createId ?? randomUUID;
        this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
        this.state = this.load();
    }
    listSessions() {
        return this.state.sessions.map(cloneSession);
    }
    getSession(sessionId) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (!normalizedSessionId)
            return null;
        const session = this.state.sessions.find((item) => item.sessionId === normalizedSessionId);
        return session ? cloneSession(session) : null;
    }
    getSelectedTab(sessionId) {
        const session = this.getSession(sessionId);
        if (!session)
            return null;
        return (session.tabs.find((tab) => tab.persistentTabId === session.selectedPersistentTabId) ??
            session.tabs[session.tabs.length - 1] ??
            null);
    }
    createTab(sessionId, input) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (!normalizedSessionId)
            throw new Error('Browser registry requires a valid sessionId');
        const now = this.now();
        let session = this.state.sessions.find((item) => item.sessionId === normalizedSessionId);
        if (!session) {
            session = {
                sessionId: normalizedSessionId,
                selectedPersistentTabId: null,
                tabs: [],
                createdAt: now,
                updatedAt: now,
            };
            this.state.sessions.push(session);
        }
        const requestedId = normalizePersistentTabId(input.persistentTabId);
        const existing = requestedId
            ? session.tabs.find((tab) => tab.persistentTabId === requestedId)
            : undefined;
        if (existing) {
            this.updateTab(normalizedSessionId, existing.persistentTabId, input);
            return { ...existing };
        }
        const requestedUrl = normalizePersistedBrowserUrl(input.requestedUrl);
        const tab = {
            persistentTabId: requestedId ?? this.createId(),
            url: normalizePersistedBrowserUrl(input.url) ?? 'about:blank',
            ...(requestedUrl ? { requestedUrl } : {}),
            title: normalizeTitle(input.title),
            order: session.tabs.length,
            createdAt: now,
            lastActiveAt: now,
        };
        session.tabs.push(tab);
        session.selectedPersistentTabId = tab.persistentTabId;
        session.updatedAt = now;
        this.prune();
        this.schedulePersist();
        return { ...tab };
    }
    updateTab(sessionId, persistentTabId, patch) {
        const session = this.findMutableSession(sessionId);
        if (!session)
            return null;
        const tab = session.tabs.find((item) => item.persistentTabId === persistentTabId);
        if (!tab)
            return null;
        const nextUrl = patch.url === undefined ? undefined : normalizePersistedBrowserUrl(patch.url);
        if (nextUrl)
            tab.url = nextUrl;
        if (patch.requestedUrl !== undefined) {
            const nextRequestedUrl = normalizePersistedBrowserUrl(patch.requestedUrl);
            if (nextRequestedUrl)
                tab.requestedUrl = nextRequestedUrl;
            else
                delete tab.requestedUrl;
        }
        if (patch.title !== undefined)
            tab.title = normalizeTitle(patch.title);
        const now = this.now();
        tab.lastActiveAt = now;
        session.updatedAt = now;
        this.schedulePersist();
        return { ...tab };
    }
    updateNavigationHistory(sessionId, persistentTabId, history) {
        const session = this.findMutableSession(sessionId);
        if (!session)
            return null;
        const tab = session.tabs.find((item) => item.persistentTabId === persistentTabId);
        if (!tab)
            return null;
        const normalized = normalizeNavigationHistory(history);
        if (!normalized)
            return null;
        tab.navigationHistory = normalized;
        const now = this.now();
        tab.lastActiveAt = now;
        session.updatedAt = now;
        this.schedulePersist();
        return cloneSession({ ...session, tabs: [tab] }).tabs[0] ?? null;
    }
    selectTab(sessionId, persistentTabId) {
        const session = this.findMutableSession(sessionId);
        if (!session || !session.tabs.some((tab) => tab.persistentTabId === persistentTabId)) {
            return false;
        }
        const now = this.now();
        session.selectedPersistentTabId = persistentTabId;
        session.updatedAt = now;
        const tab = session.tabs.find((item) => item.persistentTabId === persistentTabId);
        if (tab)
            tab.lastActiveAt = now;
        this.schedulePersist();
        return true;
    }
    removeTab(sessionId, persistentTabId) {
        const session = this.findMutableSession(sessionId);
        if (!session)
            return false;
        const nextTabs = session.tabs.filter((tab) => tab.persistentTabId !== persistentTabId);
        if (nextTabs.length === session.tabs.length)
            return false;
        session.tabs = nextTabs.map((tab, order) => ({ ...tab, order }));
        if (session.selectedPersistentTabId === persistentTabId) {
            session.selectedPersistentTabId =
                session.tabs[session.tabs.length - 1]?.persistentTabId ?? null;
        }
        session.updatedAt = this.now();
        if (session.tabs.length === 0) {
            this.state.sessions = this.state.sessions.filter((item) => item.sessionId !== session.sessionId);
        }
        this.schedulePersist();
        return true;
    }
    removeSession(sessionId) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (!normalizedSessionId)
            return false;
        const nextSessions = this.state.sessions.filter((session) => session.sessionId !== normalizedSessionId);
        if (nextSessions.length === this.state.sessions.length)
            return false;
        this.state.sessions = nextSessions;
        this.schedulePersist();
        return true;
    }
    clear() {
        this.state = { version: REGISTRY_VERSION, sessions: [] };
        this.dirty = false;
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = null;
        this.storage.clear?.();
    }
    flush() {
        if (this.persistTimer)
            clearTimeout(this.persistTimer);
        this.persistTimer = null;
        if (!this.dirty)
            return;
        this.storage.write(structuredClone(this.state));
        this.dirty = false;
    }
    dispose() {
        this.flush();
    }
    findMutableSession(sessionId) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (!normalizedSessionId)
            return null;
        return this.state.sessions.find((session) => session.sessionId === normalizedSessionId) ?? null;
    }
    load() {
        const now = this.now();
        const raw = this.storage.read();
        if (!raw || typeof raw !== 'object')
            return { version: REGISTRY_VERSION, sessions: [] };
        const candidate = raw;
        if ((candidate.version !== 1 && candidate.version !== REGISTRY_VERSION) ||
            !Array.isArray(candidate.sessions)) {
            return { version: REGISTRY_VERSION, sessions: [] };
        }
        const sessions = candidate.sessions
            .map((session) => normalizeSession(session, now))
            .filter((session) => session !== null)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_PERSISTED_BROWSER_SESSIONS);
        return { version: REGISTRY_VERSION, sessions };
    }
    prune() {
        for (const session of this.state.sessions) {
            if (session.tabs.length <= MAX_PERSISTED_BROWSER_TABS_PER_SESSION)
                continue;
            const selectedId = session.selectedPersistentTabId;
            session.tabs = session.tabs
                .slice()
                .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
                .slice(0, MAX_PERSISTED_BROWSER_TABS_PER_SESSION)
                .sort((left, right) => left.order - right.order)
                .map((tab, order) => ({ ...tab, order }));
            if (!session.tabs.some((tab) => tab.persistentTabId === selectedId)) {
                session.selectedPersistentTabId =
                    session.tabs[session.tabs.length - 1]?.persistentTabId ?? null;
            }
        }
        if (this.state.sessions.length > MAX_PERSISTED_BROWSER_SESSIONS) {
            this.state.sessions = this.state.sessions
                .slice()
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, MAX_PERSISTED_BROWSER_SESSIONS);
        }
    }
    schedulePersist() {
        this.dirty = true;
        if (this.persistTimer)
            return;
        const timer = setTimeout(() => this.flush(), this.persistDelayMs);
        timer.unref?.();
        this.persistTimer = timer;
    }
}

function loadElectronStore() {
    // The Electron main process is CommonJS. Keep this dependency out of the
    // module load path so pure registry logic remains usable in Node-only tests.
    return require('electron-store');
}
export function createPersistentBrowserRegistry(StoreConstructor = loadElectronStore()) {
    const store = new StoreConstructor({ name: 'embedded-browser-tabs' });
    return new PersistentBrowserRegistry({
        storage: {
            read: () => store.get('registry'),
            write: (state) => store.set('registry', state),
            clear: () => store.delete('registry'),
        },
    });
}
