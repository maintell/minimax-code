export function resolveAccountOnboardingInstallCohort({ persistedCohort, hadExistingDesktopStore, }) {
    if (persistedCohort)
        return persistedCohort;
    return hadExistingDesktopStore ? 'existing-install' : 'new-install';
}
export function resolveDesktopOnboardingMode({ installCohort, }) {
    return installCohort === 'new-install' ? 'account-onboarding' : 'main';
}
