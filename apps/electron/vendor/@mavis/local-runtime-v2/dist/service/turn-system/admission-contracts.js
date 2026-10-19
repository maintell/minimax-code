export function composeTurnAdmissionPolicies(...policies) {
    return {
        applyInTransaction(db, input) {
            for (const policy of policies) {
                const rejection = policy.applyInTransaction(db, input);
                if (rejection)
                    return rejection;
            }
            return undefined;
        },
    };
}
//# sourceMappingURL=admission-contracts.js.map