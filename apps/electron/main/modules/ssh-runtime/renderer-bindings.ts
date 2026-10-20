import { RUNTIME_TRANSPORT_PORT_CHANNEL, RUNTIME_READY_CHANNEL, RUNTIME_FAILED_CHANNEL, RUNTIME_TRANSPORT_LOST_CHANNEL } from "../local-runtime/utility/control";
import { PROJECT_RUNTIME_TRANSPORT_PORT_CHANNEL, PROJECT_RUNTIME_STATUS_CHANNEL, PROJECT_RUNTIME_FAILED_CHANNEL, PROJECT_RUNTIME_TRANSPORT_LOST_CHANNEL } from "./project-runtime-channels";
const disconnected = () => ({
    enabled: true,
    connected: false,
});
/** Owns project/renderer intents and port attachment lifetimes; never closes a host. */
export class SshRendererBindings {
    constructor() {
        this.bindings = new Map();
        this.nextTargetId = 0;
    }
    begin(runtimeId, target, intentId) {
        let binding = this.bindings.get(runtimeId)?.get(target.id);
        if (binding && binding.intentId !== intentId) {
            this.release(runtimeId, target.id, 'renderer-request');
            binding = undefined;
        }
        let targets = this.bindings.get(runtimeId);
        if (!targets)
            this.bindings.set(runtimeId, (targets = new Map()));
        if (!binding) {
            binding = {
                target: { ...createScopedTarget(runtimeId, target, intentId), id: ++this.nextTargetId },
                intentId,
                attempt: {},
            };
            targets.set(target.id, binding);
        }
        if (binding.attachment && !binding.attachment.manager.isReady()) {
            const previous = binding.attachment;
            binding.attachment = undefined;
            previous.manager.disconnectRenderer(binding.target.id, 'renderer-request');
        }
        const attempt = {};
        binding.attempt = attempt;
        const captured = binding;
        return {
            target: binding.target,
            isCurrent: () => this.bindings.get(runtimeId)?.get(target.id) === captured && captured.attempt === attempt,
        };
    }
    *entries() {
        for (const [runtimeId, targets] of this.bindings) {
            yield [runtimeId, new Map([...targets].map(([id, binding]) => [id, binding.target]))];
        }
    }
    runtimeIds() {
        return this.bindings.keys();
    }
    hasTargets(runtimeId) {
        return Boolean(this.bindings.get(runtimeId)?.size);
    }
    attach(runtimeId, rendererId, manager) {
        const binding = this.bindings.get(runtimeId)?.get(rendererId);
        if (!binding)
            return Promise.resolve(disconnected());
        const previous = binding.attachment;
        if (previous?.manager === manager) {
            if (previous.connected && manager.isReady())
                return Promise.resolve({ enabled: true, connected: true });
            if (previous.pending)
                return previous.pending;
        }
        if (previous)
            previous.manager.disconnectRenderer(binding.target.id, 'renderer-request');
        const attachment = { manager, connected: false };
        binding.attachment = attachment;
        const isCurrent = () => this.bindings.get(runtimeId)?.get(rendererId) === binding &&
            binding.attachment === attachment;
        const target = {
            ...binding.target,
            postMessage: (channel, message, transfer) => {
                if (isCurrent())
                    binding.target.postMessage(channel, message, transfer);
                else
                    for (const port of transfer ?? []) {
                        try {
                            port.close();
                        }
                        catch {
                            /* already closed */
                        }
                    }
            },
            send: (channel, message) => {
                if (isCurrent())
                    binding.target.send(channel, message);
            },
        };
        const task = Promise.resolve()
            .then(() => (isCurrent() ? manager.connectRenderer(target) : disconnected()))
            .catch(disconnected)
            .then((result) => {
            if (!isCurrent()) {
                // A late transfer is not allowed to leave an orphaned manager-side port.
                // A newer attempt on the same manager has its own attempt guard.
                if (binding.attachment?.manager !== manager)
                    manager.disconnectRenderer(target.id, 'renderer-request');
                return disconnected();
            }
            attachment.connected = result.connected === true && manager.isReady();
            return attachment.connected ? result : disconnected();
        })
            .finally(() => {
            if (attachment.pending === task)
                attachment.pending = undefined;
        });
        attachment.pending = task;
        return task;
    }
    forgetManager(manager) {
        for (const targets of this.bindings.values())
            for (const binding of targets.values()) {
                if (binding.attachment?.manager !== manager)
                    continue;
                binding.attachment = undefined;
                manager.disconnectRenderer(binding.target.id, 'renderer-request');
            }
    }
    release(runtimeId, rendererId, reason, intentId) {
        const targets = this.bindings.get(runtimeId);
        const binding = targets?.get(rendererId);
        if (intentId && binding && binding.intentId !== intentId)
            return false;
        targets?.delete(rendererId);
        if (!targets?.size)
            this.bindings.delete(runtimeId);
        if (binding) {
            const attachment = binding.attachment;
            binding.attachment = undefined;
            attachment?.manager.disconnectRenderer(binding.target.id, reason);
        }
        return true;
    }
    clear() {
        for (const [runtimeId, targets] of this.bindings)
            for (const id of targets.keys())
                this.release(runtimeId, id, 'renderer-request');
    }
}

function createScopedTarget(runtimeId, target, transportIntentId) {
    let connectionId;
    return {
        id: target.id,
        postMessage: (channel, message, transfer) => {
            if (channel !== RUNTIME_TRANSPORT_PORT_CHANNEL)
                return;
            const portId = asRecord(message).connectionId;
            if (typeof portId === 'string')
                connectionId = portId;
            target.postMessage(PROJECT_RUNTIME_TRANSPORT_PORT_CHANNEL, { runtimeId, ...asRecord(message), ...(transportIntentId ? { transportIntentId } : {}) }, transfer);
        },
        send: (channel, message) => {
            if (channel === RUNTIME_READY_CHANNEL)
                return;
            if (channel === PROJECT_RUNTIME_STATUS_CHANNEL) {
                safeTargetSend(target, channel, {
                    ...asRecord(message),
                    ...(transportIntentId ? { transportIntentId } : {}),
                });
                return;
            }
            if (channel === RUNTIME_FAILED_CHANNEL) {
                safeTargetSend(target, PROJECT_RUNTIME_FAILED_CHANNEL, {
                    runtimeId,
                    ...asRecord(message),
                    ...(transportIntentId ? { transportIntentId } : {}),
                });
                return;
            }
            if (channel === RUNTIME_TRANSPORT_LOST_CHANNEL) {
                safeTargetSend(target, PROJECT_RUNTIME_TRANSPORT_LOST_CHANNEL, {
                    runtimeId,
                    ...(connectionId ? { connectionId } : {}),
                    ...asRecord(message),
                    ...(transportIntentId ? { transportIntentId } : {}),
                });
            }
        },
    };
}
function safeTargetSend(target, channel, message) {
    try {
        target.send(channel, message);
    }
    catch {
        /* A closed window must not stop host recovery. */
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
