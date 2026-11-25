/**
 * Argument documentation for a tool whose schema is a command's zod schema
 * converted to JSON Schema: the schema says the shape, this says what each
 * argument means. Shared by the namespaced mavis tools and the coordinator's
 * own tools.
 */
/** Adds each argument's line to the top-level object, or to every branch of a top-level union. */
export function describeProperties(schema, toolName, fields) {
    const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
    for (const branch of branches) {
        const properties = branch.properties;
        for (const [key, property] of Object.entries(properties ?? {})) {
            const description = fields[key];
            if (!description)
                throw new Error(`${toolName}: argument ${key} has no description`);
            property.description = description;
        }
    }
    return schema;
}
//# sourceMappingURL=local-mavis-schema-docs.js.map