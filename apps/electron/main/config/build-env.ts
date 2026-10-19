// Electron buildEnv -> daemon MAVIS_BUILD_ENV mapping.
// Values come from .env.* files: dev | test | staging | prod.
export let BUILD_ENV_TO_MAVIS = {
    dev: 'test',
    test: 'test',
    staging: 'staging',
    prod: 'prod',
};
