# Spec: automatic backups are encrypted under a wrapped data key, not a stored password

Design note for replacing the recoverable copy of each user's password in
`users.backup_password_enc` with envelope encryption. Written before the
implementation, per `AGENTS.md` ("a feature of substance starts from a short
spec"). The backup contract it amends is `docs/backup-restore-contract.md`
sections 6 and 7; the operational summary is `docs/backend/backup.md`.

## 1. The defect

An automatic backup is written by a cron that has no user present, and it is
encrypted so that the user can open it with their own password. To make both
true the server kept the password itself: `rememberLoginPassword` stored every
local account's login password on registration, login and password change as
AES-GCM ciphertext under `ENCRYPTION_KEY`, and an OIDC account's dedicated
backup password the same way. Anyone holding a database dump and the server's
environment recovered every user's real password, which matters beyond this
application because people reuse passwords.

The cron does not need the password. It needs a key that the password can
later recover. That is what this spec stores instead.

## 2. Key flow

Each user who has backup encryption gets a random 32-byte **data key**. The
server stores three things on `users`, and nothing that decrypts to a password:

| Column | Holds | Who can open it |
|---|---|---|
| `backup_key_enc` | the data key, base64, as `EncryptionService` ciphertext under `ENCRYPTION_KEY` | the server, so the cron can encrypt without the password |
| `backup_key_wrap` | the data key wrapped under `scrypt(password, salt)` (AES-256-GCM): `salt(16) \|\| iv(12) \|\| tag(16) \|\| wrapped(32)`, base64 | whoever knows the password |
| `backup_key_password_ref` | SHA-256 of the `password_hash` the wrap was made for (local accounts); `NULL` for an OIDC dedicated backup password | nobody; a staleness check |

**An SSO link keeps the key.** Linking a local account to SSO keeps its
`password_hash` and `backup_key_password_ref` (`adoptOidcIdentity`,
`backend/src/auth/auth.service.ts`), so the wrap stays tied to the hash it was
made for. Whether that password may sign in is `OIDC_ALLOW_PASSWORD_LOGIN`'s
decision, not the link's.

The scrypt parameters are the envelope's existing ones (`deriveKey` in
`backup-envelope.ts`, N=32768, r=8, p=1), so opening a file costs what it
always did.

**When a password is available in plaintext** (registration, login,
change-password, the Settings "use my login password" confirmation, the OIDC
backup-password form) the server makes a **fresh** data key, wraps it under
that password, writes the three columns and clears `backup_password_enc` in one
conditional `UPDATE`. For a local account the `UPDATE` is keyed on the
`password_hash` the caller verified the password against, so a wrap can never
be recorded against a hash its password does not match. A login whose
`backup_key_password_ref` already matches the verified hash writes nothing:
the wrap is current, and skipping it keeps the ~100ms of scrypt off every
sign-in.

A fresh key per wrap, rather than one key re-wrapped, is deliberate: after a
password change the old password, together with any older backup file, must
not open backups written after the change.

**At backup time** the cron decrypts `backup_key_enc`, and writes the file
under that data key with `backup_key_wrap` copied into the file's header. It
never sees or needs the password.

**Staleness.** A password set by a path that has no reason to re-wrap (an
emailed reset link, an admin reset, an emergency-access claim) changes
`password_hash` and so no longer matches `backup_key_password_ref`. The cron
treats that wrap as stale exactly as it treated a stale stored password: it
drops the key and writes that backup unencrypted (and logs it) until the next
sign-in re-wraps, rather than writing a file only the forgotten password
opens.

## 3. File format: `MZBE` v3

```
v3 (framed, key-wrapped)
  bytes   0..3    magic        "MZBE"
  byte    4       version      0x03
  byte    5       kdf          0x01 = scrypt
  bytes   6..81   wrappedKey   salt(16) iv(12) tag(16) wrappedDataKey(32)
  bytes  82..97   keySalt      16 bytes, per file
  bytes  98..104  noncePrefix  7 bytes, per file
  bytes 105..     frames       [uint32 BE length][ciphertext||tag] ...
```

The frames are the v2 STREAM construction unchanged (per-frame tag, nonce
`prefix || counter || finalFlag`, the whole header as AAD). The frame key is
`HKDF-SHA256(dataKey, keySalt, "monize-backup-v3-file-key")`, so the same data
key used for many files never meets the same GCM nonce twice. The wrap is
sealed with the first six header bytes (magic, version, kdf) as its AAD.

**Opening a v3 file with the password:** derive `scrypt(password, salt)`,
unwrap the data key (a wrong password fails the wrap's tag and surfaces as the
same `BackupDecryptionError` as before), derive the frame key, open the frames.
**The restore experience does not change**: the same password prompt, the same
candidates (the typed backup password, the login password), plus the stored
data key, which opens files written since the last re-wrap without asking.

Readers keep opening v1 and v2. The manual download and the support export
still write v2 and v1 under the password the user types at that moment; only
the automatic backup, the one path that had to hold a password, writes v3.

## 4. Migration of existing rows

The migration (prefix 20260922211000, `backup_key_wrapping`) only adds the three
nullable columns; `backup_password_enc` stays for now (expand, then contract in
a later release). No password is decrypted in SQL. Conversion is lazy, from the
first of:

- **the next time the password is typed** (login, change-password, Settings):
  the new wrap is written and `backup_password_enc` cleared in the same
  `UPDATE`;
- **the next automatic backup**: the cron already decrypts the legacy copy and
  checks it against the account's current hash, so it wraps a fresh data key
  under it, writes the columns and clears `backup_password_enc` (conditional on
  the ciphertext it read still being there), and encrypts that backup under the
  new key. This is what converts OIDC accounts, whose dedicated password is
  never typed at sign-in, and local accounts whose session outlives the deploy.

A not-yet-converted user therefore gets an encrypted backup on the next run
exactly as today, decryptable with the same password, and leaves the run
converted. If the conversion write fails, that backup is still encrypted under
the key just made; the next run tries again.

## 5. Failure modes

| Situation | Outcome |
|---|---|
| `ENCRYPTION_KEY` rotated or lost | `backup_key_enc` cannot be decrypted: `unrecoverable`, the backup is refused, as before. Files already written still open with the password. |
| Password changed by reset, admin or emergency claim | wrap is stale by `backup_key_password_ref`; key dropped, backup written unencrypted and logged until the next sign-in, as before. |
| Password changed by the user | re-wrapped under a fresh data key in the same request. Files written earlier open with the password that was current when they were written, as before. |
| Concurrent password change between verification and re-wrap | the conditional `UPDATE` matches no row and writes nothing; the next sign-in re-wraps. |
| Stored columns corrupt (bad base64, wrong length) | `unrecoverable`, refused, never a plaintext downgrade. |
| Previous release still serving during a rolling deploy | an old pod finds no `backup_password_enc` for a converted user and writes that backup unencrypted (logged, and refused for off-machine copy by INV-BACKUP-002); an old pod's login writes a legacy copy that the next new-pod login or backup converts again. |
| A v3 file restored on a build older than this one | not recognised as an encrypted envelope; as with v2 before it, restore on a build at least as new as the one that wrote the file. |

What an attacker with a database dump **and** the environment now gets: each
user's current data key, which opens that user's automatic backups written
since their last re-wrap (as the stored password did), and no password. With a
dump alone: `backup_key_wrap`, an offline guessing target no cheaper than the
bcrypt `password_hash` beside it.

## 6. Tests

- no value that decrypts to the password is stored after login, registration,
  change-password, Settings confirmation or the OIDC form, and
  `backup_password_enc` is cleared by each;
- the cron encrypts from the stored columns without the password, and the file
  opens with the password alone;
- v1 and v2 files still open;
- a password change re-wraps under a fresh key, and the old password does not
  open the new file;
- a not-yet-converted user still gets an encrypted backup, and the run clears
  `backup_password_enc`;
- a stale wrap is dropped rather than used.
