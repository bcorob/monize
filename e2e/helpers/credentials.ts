/**
 * The password every user the E2E suite registers gets unless a test supplies
 * its own. It opens nothing outside the throwaway e2e database, so it is not a
 * secret -- but the register helper, the API helper, the admin fixture and the
 * specs that hand a delegate a login all have to agree on it, and eight literal
 * copies was how a spec could log in with a password the helper never set.
 */
export const E2E_DEFAULT_PASSWORD = 'E2eTestPass123!';
