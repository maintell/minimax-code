/** A rejected operation does not poison the session; every caller observes its own result. */
export class PptEditSerialQueue {
    constructor() {
        this.tail = Promise.resolve();
    }
    run(operation) {
        const current = this.tail.then(operation);
        this.tail = current.catch(() => undefined);
        return current;
    }
}

