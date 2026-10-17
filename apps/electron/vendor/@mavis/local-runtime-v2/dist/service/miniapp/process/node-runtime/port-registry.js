/** Node-runtime authority for product-reserved and active MiniApp loopback ports. */
export class HostMiniAppPortRegistry {
    productReserved;
    owners = new Map();
    constructor(productReserved = new Set()) {
        this.productReserved = productReserved;
    }
    isReserved(input) {
        return this.productReserved.has(input.port) || this.owners.has(input.port);
    }
    reserve(input) {
        if (this.productReserved.has(input.port) || this.owners.has(input.port))
            return undefined;
        const owner = Object.freeze({
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
        });
        this.owners.set(input.port, owner);
        let released = false;
        return {
            release: () => {
                if (released)
                    return;
                released = true;
                if (this.owners.get(input.port) === owner)
                    this.owners.delete(input.port);
            },
        };
    }
}
//# sourceMappingURL=port-registry.js.map