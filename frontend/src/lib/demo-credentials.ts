/**
 * The demo account's login, pre-filled on the sign-in form when the server
 * reports `DEMO_MODE`. Public by design (a demo site publishes its own login),
 * so not a secret -- but it has to match what the server seeds, which lives in
 * `backend/src/database/demo-credentials.ts`. `demo-credentials.contract.test.ts`
 * reads that file and fails when the two drift, because a form that pre-fills
 * a password the seed no longer sets is a demo nobody can enter.
 */
export const DEMO_USER_EMAIL = 'demo@monize.com';
export const DEMO_USER_PASSWORD = 'Demo123!';
