import path from 'node:path';
import ts from 'typescript';
export function typeErrors(packageDir, format = (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) {
    const configFile = ts.readConfigFile(path.join(packageDir, 'tsconfig.json'), ts.sys.readFile);
    if (configFile.error)
        return [format(configFile.error, packageDir)];
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageDir);
    const diagnostics = [...parsed.errors];
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
    return diagnostics.map((diagnostic) => format(diagnostic, packageDir));
}
//# sourceMappingURL=test-helpers.js.map