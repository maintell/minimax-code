import { createSiteTable } from '@mavis/shared/plugin-extension';
import { createExtensionTesting } from '../../sdk/testing/harness.js';
import { describeError } from '../../host/realm/realm.js';
import { createTestingDriver } from './driver.js';
import { TestRealm } from './realm.js';
const MAX_LOG_LINES = 50;
/** What `import { register } from './register'` resolves to inside a test. */
const moduleToken = () => {
    throw new Error('The module under test runs in its own realm; pass `register` to mount()');
};
/**
 * Worker side of one test file: loads the bundle, then runs its cases from `job.from` in order and
 * reports each one. The supervising thread owns the hard deadline; the timeout here only ends a
 * test that is still waiting, so its diagnostics and logs survive.
 */
export async function runTestFile(job, post) {
    const module = {
        pluginId: job.pluginId,
        token: moduleToken,
        artifact: job.artifact,
    };
    const mounted = [];
    const base = createTestingDriver({ module, sites: createSiteTable(job.sites) });
    const driver = {
        sleep: base.sleep,
        mount: async (spec) => {
            const site = await base.mount(spec);
            mounted.push(site);
            return site;
        },
    };
    const harness = createExtensionTesting(driver);
    // Lines logged while the bundle loads belong to no case.
    let logged = MAX_LOG_LINES;
    const realm = new TestRealm({
        testing: publicApi(harness),
        moduleUnderTest: Object.freeze({ register: module.token }),
        specifiers: job.specifiers,
        syncTimeoutMs: job.syncTimeoutMs,
        onLog: (level, text) => {
            if (logged >= MAX_LOG_LINES)
                return;
            logged += 1;
            post({ t: 'log', line: `[${level}] ${text}` });
        },
    });
    try {
        realm.load(job.code, job.file);
    }
    catch (error) {
        post({ t: 'load-failed', error: describeError(error) });
        return;
    }
    post({ t: 'loaded', names: harness.registered.map((test) => test.name) });
    for (const [index, test] of harness.registered.entries()) {
        if (index < job.from)
            continue;
        logged = 0;
        post({ t: 'case-start', index });
        const started = Date.now();
        let error;
        try {
            await withTimeout(realm.run(test.fn), job.testTimeoutMs, test.name);
        }
        catch (thrown) {
            error = describeError(thrown);
        }
        const diagnostics = mounted.splice(0).flatMap((site) => site.diagnostics());
        await harness.unmountAll();
        post({
            t: 'case-end',
            index,
            result: {
                name: test.name,
                status: error === undefined ? 'passed' : 'failed',
                durationMs: Date.now() - started,
                ...(error === undefined ? {} : { error }),
                diagnostics,
            },
        });
    }
    post({ t: 'done' });
}
function publicApi(harness) {
    const { mount, find, findAll, press, waitFor, completeAgent, unmount, test, expect } = harness;
    return { mount, find, findAll, press, waitFor, completeAgent, unmount, test, expect };
}
async function withTimeout(work, ms, name) {
    let timer;
    try {
        await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`test "${name}" timed out after ${ms} ms`)), ms);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=file-run.js.map