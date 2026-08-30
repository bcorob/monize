# Security Policy

## Supported Versions

Monize is under active development. Security updates are applied to the latest
release on the `main` branch. Older versions are not supported.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| < main  | :x:                |

## Reporting a Vulnerability

We take the security of Monize seriously. If you believe you have found a
security vulnerability, please report it to us privately. **Please do not
disclose the issue publicly until we have had a chance to address it.**

### How to Report

Please use one of the following channels to report a vulnerability:

1. **GitHub Security Advisories (preferred):** Open a private advisory at
   <https://github.com/kenlasko/monize/security/advisories/new>.
2. **Email:** Send the details to the repository maintainer via the email
   address listed on their GitHub profile.

### What to Include

To help us triage and resolve the issue quickly, please include as much of the
following as possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce the issue, including any required configuration.
- Affected versions, commits, or branches.
- Proof-of-concept code, screenshots, or logs (if applicable).
- Any suggested mitigations or fixes.

### Our Commitment

When you report a vulnerability, we will:

- Acknowledge receipt of your report within **3 business days**.
- Provide an initial assessment within **7 business days**.
- Keep you informed of our progress as we investigate and remediate the issue.
- Credit you in the release notes for the fix, unless you prefer to remain
  anonymous.

## Scope

The following are in scope for security reports:

- The Monize backend (NestJS API).
- The Monize frontend (Next.js app).
- Database migrations and schema definitions in `database/`.
- Authentication, authorization, session management, and 2FA flows.
- Handling of financial data, API keys, and other secrets.
- Docker and Helm deployment configurations included in this repository.

The following are **out of scope**:

- Vulnerabilities in third-party dependencies that have not been patched
  upstream (please report those to the upstream project first).
- Issues that require physical access to a user's device.
- Social engineering of users or maintainers.
- Denial-of-service attacks that rely on overwhelming volume rather than a
  software defect.
- Findings from automated scanners without a demonstrated, exploitable impact.

## Security Best Practices for Self-Hosted Deployments

If you self-host Monize, please follow these guidelines:

- Set `JWT_SECRET` and `ENCRYPTION_KEY` (formerly `AI_ENCRYPTION_KEY`, still accepted) to strong, random values of at least
  32 characters. Never reuse the example values from `.env.example`.
- Run the application behind HTTPS, with TLS terminated at a trusted reverse
  proxy or load balancer.
- Restrict database network access to the application host(s) only.
- Keep your deployment up to date with the latest `main` branch to receive
  security fixes.
- Rotate secrets, API keys, and OIDC client credentials periodically and after
  any suspected compromise.
- Enable two-factor authentication (TOTP) for all user accounts.
- Back up your PostgreSQL database regularly and verify that backups can be
  restored.

## Disclosure Policy

We follow a **coordinated disclosure** model:

1. The reporter submits the vulnerability privately.
2. We confirm the issue and develop a fix.
3. We release the fix and publish a security advisory.
4. After users have had a reasonable time to update (typically 30 days), the
   reporter may publicly disclose the details if they wish.

Thank you for helping keep Monize and its users safe.
