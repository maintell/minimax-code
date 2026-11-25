import { EXTENSION_TESTING_SPECIFIER } from '../../contracts.js';
import { compileExtensionTest, MODULE_UNDER_TEST_SPECIFIER } from '../../workspace/compile.js';
import { runTestFileInWorker, TEST_WORKER_LIMITS } from './file-supervisor.js';
const TEST_FILE = /\.test\.(?:tsx|ts|jsx|js)$/u;
const SYNC_TIMEOUT_MS = 2_000;
/**
 * `extension test`: every `*.test.tsx` of the snapshot, against the validated artifact. Each file
 * runs in its own terminable Worker; this thread only compiles and supervises.
 */
export async function runExtensionTests(input) {
    const { artifact } = input;
    const limits = { ...TEST_WORKER_LIMITS, ...input.limits };
    const module = {
        pluginId: artifact.pluginId,
        artifact: {
            digest: artifact.digest,
            code: artifact.compiled.code,
            hooks: artifact.scan.hooks.map(({ slot, matcher }) => matcher ? { slot, matcher } : { slot }),
            calls: artifact.scan.calls.map(({ domain, method, server }) => server === undefined ? { domain, method } : { domain, method, server }),
        },
    };
    const sites = input.sites.slots.flatMap((slot) => input.sites.get(slot) ?? []);
    const files = [];
    for (const file of artifact.files.filter((candidate) => TEST_FILE.test(candidate))) {
        if (input.signal?.aborted)
            break;
        const compiled = await compileExtensionTest({
            root: artifact.candidateRoot,
            file,
            moduleEntry: artifact.entry,
        });
        if (!compiled.ok) {
            files.push({ file, diagnostics: compiled.diagnostics, tests: [] });
            continue;
        }
        files.push(await runTestFileInWorker({
            factory: input.workerFactory,
            limits,
            job: {
                file,
                code: compiled.compiled.code,
                ...module,
                sites,
                specifiers: {
                    testing: EXTENSION_TESTING_SPECIFIER,
                    moduleUnderTest: MODULE_UNDER_TEST_SPECIFIER,
                },
                syncTimeoutMs: SYNC_TIMEOUT_MS,
            },
            ...(input.signal ? { signal: input.signal } : {}),
        }));
    }
    const cases = files.flatMap((file) => file.tests);
    return {
        passed: cases.filter((test) => test.status === 'passed').length,
        failed: cases.filter((test) => test.status === 'failed').length +
            files.filter((file) => file.tests.length === 0 && (file.error || file.diagnostics.length))
                .length,
        files,
    };
}
//# sourceMappingURL=runner.js.map