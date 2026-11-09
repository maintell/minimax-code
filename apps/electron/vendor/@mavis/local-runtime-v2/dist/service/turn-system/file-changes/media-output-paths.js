export function collectMediaOutputPaths(toolArgs, maxPathsPerRequest) {
    const paths = new Set();
    const collectOutputs = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 3)
            return;
        if (Array.isArray(value)) {
            value.slice(0, maxPathsPerRequest).forEach((item) => collectOutputs(item, depth + 1));
            return;
        }
        const record = value;
        if (typeof record.output_file_path === 'string') {
            paths.add(record.output_file_path);
        }
        if (Array.isArray(record.output_file_path_list)) {
            for (const item of record.output_file_path_list) {
                if (typeof item === 'string')
                    paths.add(item);
            }
        }
        if (record.requests)
            collectOutputs(record.requests, depth + 1);
    };
    collectOutputs(toolArgs, 0);
    return [...paths];
}
//# sourceMappingURL=media-output-paths.js.map