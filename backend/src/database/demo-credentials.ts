/**
 * The demo account's identity, written once.
 *
 * `DEMO_MODE` deployments are public by design: the login page pre-fills these
 * values and `.env.example` prints them, so neither is a secret -- but the seed
 * that creates the user, the nightly reset that restores its password, the
 * start-up probe that decides whether to seed at all and the client that
 * pre-fills the form all have to agree on them. Four copies of a value that
 * must match is how a demo site stops accepting its own published login, so
 * every reader imports from here and `demo-credentials.spec.ts` fails a second
 * spelling anywhere under `src/`. The client keeps its own copy in
 * `frontend/src/lib/demo-credentials.ts`, and a contract test on that side
 * reads this file to check the two agree.
 */
export const DEMO_USER_EMAIL = "demo@monize.com";
export const DEMO_USER_PASSWORD = "Demo123!";
