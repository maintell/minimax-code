export function withModelProviderResponsePolicy(bindings) {
    return bindings.map((binding) => binding.kind === 'json' && binding.name === 'revealModelProviderApiKey'
        ? { ...binding, responseHeaders: { ...binding.responseHeaders, 'Cache-Control': 'no-store' } }
        : binding);
}
//# sourceMappingURL=model-provider-response-policy.js.map