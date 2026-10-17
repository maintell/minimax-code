import { DEFAULT_OBSERVABILITY_REDACTION_POLICY, sanitizeObservabilityText } from './redaction.js';
const DEFAULT_PRIVACY = {
    redaction: 'masked',
    uploadDefault: 'consent-required',
};
export const NOOP_OBSERVABILITY_LOGGER = {
    child: () => NOOP_OBSERVABILITY_LOGGER,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    flush: async () => undefined,
};
export function serializeObservabilityError(error) {
    if (error instanceof Error) {
        const maybeCode = error.code;
        return {
            name: error.name,
            message: sanitizeObservabilityText(error.message),
            ...(error.stack ? { stack: sanitizeObservabilityText(error.stack) } : {}),
            ...(typeof maybeCode === 'string' ? { code: maybeCode } : {}),
        };
    }
    return { message: sanitizeObservabilityText(String(error)) };
}
class DefaultObservabilityEventSink {
    component;
    context;
    sinks;
    nowMs;
    privacy;
    redaction = DEFAULT_OBSERVABILITY_REDACTION_POLICY;
    constructor(options) {
        this.component = options.component;
        this.context = options.context ?? {};
        this.sinks = options.sinks ?? [];
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.privacy = options.privacy ?? DEFAULT_PRIVACY;
        if (options.redaction) {
            this.redaction = options.redaction;
        }
    }
    child(context) {
        const { component, ...childContext } = context;
        return new DefaultObservabilityEventSink({
            component: component ?? this.component,
            context: { ...this.context, ...childContext },
            sinks: this.sinks,
            nowMs: this.nowMs,
            redaction: this.redaction,
            privacy: this.privacy,
        });
    }
    debug(message, fields) {
        this.emit('debug', message, fields);
    }
    info(message, fields) {
        this.emit('info', message, fields);
    }
    warn(message, fields) {
        this.emit('warn', message, fields);
    }
    error(message, fields) {
        if (fields instanceof Error) {
            this.emit('error', message, undefined, fields);
            return;
        }
        this.emit('error', message, fields);
    }
    async flush() {
        await Promise.allSettled(this.sinks.map((sink) => sink.flush?.()));
    }
    emit(level, message, fields, error) {
        const sanitizedFields = fields ? this.redaction.sanitizeFields(fields) : undefined;
        const event = {
            schemaVersion: 1,
            tsMs: this.nowMs(),
            level,
            component: this.component,
            message: sanitizeObservabilityText(message),
            ...(Object.keys(this.context).length > 0 ? { context: this.context } : {}),
            ...(sanitizedFields && Object.keys(sanitizedFields).length > 0
                ? { fields: sanitizedFields }
                : {}),
            ...(error ? { error: serializeObservabilityError(error) } : {}),
            privacy: this.privacy,
        };
        for (const sink of this.sinks) {
            try {
                void sink.emit(event);
            }
            catch {
                // Observability must never break product behavior.
            }
        }
    }
}
export function createObservabilityEventSink(options) {
    if (!options.sinks || options.sinks.length === 0)
        return NOOP_OBSERVABILITY_LOGGER;
    return new DefaultObservabilityEventSink(options);
}
//# sourceMappingURL=event-sink.js.map