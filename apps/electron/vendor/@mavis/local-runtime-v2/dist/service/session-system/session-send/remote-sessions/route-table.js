const REMOTE_SESSION_ROUTE_CAPACITY = 2000;
/**
 * In-memory `source + session_id → device` routes, least recently used first
 * out. Never persisted: a Runtime restart starts empty and probes again.
 */
export class RemoteSessionRouteTable {
    capacity;
    now;
    routes = new Map();
    constructor(capacity = REMOTE_SESSION_ROUTE_CAPACITY, now = Date.now) {
        this.capacity = capacity;
        this.now = now;
    }
    get size() {
        return this.routes.size;
    }
    get(source, sessionId) {
        const key = routeKey(source, sessionId);
        const route = this.routes.get(key);
        if (!route)
            return undefined;
        this.routes.delete(key);
        this.routes.set(key, route);
        return route;
    }
    set(source, sessionId, device) {
        const key = routeKey(source, sessionId);
        this.routes.delete(key);
        this.routes.set(key, {
            source,
            deviceId: device.deviceId,
            ...(device.name ? { name: device.name } : {}),
            ...(device.host ? { host: device.host } : {}),
            resolvedAtMs: this.now(),
        });
        while (this.routes.size > this.capacity) {
            const oldest = this.routes.keys().next().value;
            if (oldest === undefined)
                break;
            this.routes.delete(oldest);
        }
    }
    delete(source, sessionId) {
        this.routes.delete(routeKey(source, sessionId));
    }
    /** Drops every route to a device that was removed, disconnected or unbound. */
    deleteDevice(source, deviceId) {
        for (const [key, route] of this.routes) {
            if (route.source === source && route.deviceId === deviceId)
                this.routes.delete(key);
        }
    }
    /** Keeps only routes to devices that are currently present and available. */
    retainDevices(source, available) {
        for (const [key, route] of this.routes) {
            if (route.source === source && !available.has(route.deviceId))
                this.routes.delete(key);
        }
    }
}
function routeKey(source, sessionId) {
    return `${source}\u0000${sessionId}`;
}
//# sourceMappingURL=route-table.js.map