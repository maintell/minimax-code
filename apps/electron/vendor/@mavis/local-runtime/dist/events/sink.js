import { projectLocalRuntimeEvent, } from '../runtime/projection.js';
export class LocalEventSink {
    runtimeEvents = [];
    projectedFrames = [];
    subscribers = new Set();
    constructor(subscriber) {
        if (subscriber)
            this.subscribers.add(subscriber);
    }
    get events() {
        return this.runtimeEvents;
    }
    get frames() {
        return this.projectedFrames;
    }
    subscribe(subscriber) {
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }
    snapshot() {
        return {
            events: [...this.runtimeEvents],
            frames: [...this.projectedFrames],
        };
    }
    async pushRuntime(event) {
        this.runtimeEvents.push(event);
        const frame = projectLocalRuntimeEvent(event);
        if (!frame)
            return;
        this.projectedFrames.push(frame);
        for (const subscriber of this.subscribers) {
            await subscriber(frame, event);
        }
    }
    async appendEvents(events) {
        for (const event of events) {
            await this.pushRuntime(event);
        }
    }
}
//# sourceMappingURL=sink.js.map