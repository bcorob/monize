# Importing from Microsoft Money

Monize reads Microsoft Money `.mny` files directly. Not a QIF export of one --
the file itself, with its accounts, transactions, transfers, splits, securities,
price history, exchange rates and scheduled bills intact.

There is nothing to install. Money does not need to be on the machine, and the
file never leaves your Monize server.

## Before you start

**Import into an empty profile.** Version 1 does not merge: it creates what the
file describes, and if an account of the same name already exists it adds
transactions to it rather than working out which ones you already have. On a
profile that already has data you will get duplicates.

If you have been trying Monize out and want to start over from Money, the review
step offers **Start fresh**, which runs the same Delete My Data operation as
Settings → Danger Zone before the import begins. It asks you to type a
confirmation word and re-enter your password, and it cannot be undone.

**Work from a copy.** Monize never writes to the file, but a spare copy of three
decades of finances costs nothing.

**Money 97 and 98 files are not supported.** Those predate the format Monize
reads. Open the file once in the free Money Plus Sunset edition and save it; that
converts it, and the result imports normally. Monize detects these files and
says so rather than failing obscurely.

`.mbf` backup archives are also unsupported. Restore the backup in Money first
and import the resulting `.mny`.

## Importing

1. Go to **Import** and choose your `.mny` file. Monize reads it on the server
   and shows a preview -- nothing is written yet.

2. **If the file asks for a password**, type it. Every Money file is encrypted,
   but most are encrypted with a blank password and open without asking; the
   prompt only appears when a real password is set. The password is used once to
   read the file and is never stored. A wrong password says so specifically, so
   you can tell "this needs a password" apart from "that one was wrong".

3. **Review what will be imported.** This step is worth the minute it takes:

   - Every account, with its type, currency, transaction count and the **final
     balance computed from the Money file itself**. Compare a few against Money.
     That same number is what the report reconciles against afterwards.
   - Untick any account you do not want. Closed accounts are included by
     default and stay closed; they still hold history worth keeping.
   - Override an account's currency if Money had it wrong.
   - Counts for payees, categories, securities, prices, rates and bills, each
     shown against the total in the file, so "40 of 500 payees" is visible
     before rather than after.
   - **Scheduled bills** appear as a checkbox list. Money keeps one row per
     occurrence, so a long history holds thousands of them for a handful of real
     bills; Monize detects the live series and pre-ticks those. An unticked bill
     is simply not created.
   - **Notes about this file** collects anything ambiguous -- securities sharing
     a symbol, an action code Money did not document, a repeat interval with no
     exact equivalent. Worth reading; none of it stops the import.

4. **Start the import.** It runs on the server, so you can leave the page and
   come back. A large file takes a few minutes; the progress list shows which
   phase is running.

5. **Check the verification report.** Every account is listed with the balance
   computed from your Money file, the balance it ended up with in Monize, and
   the difference. Investment accounts additionally compare share counts against
   Money's own open tax lots. A green run says every account reconciles; anything
   that does not is listed with the delta so you can look at it directly. The
   report downloads as JSON if you want to keep it.

## Options

| Option | Default | What it does |
|---|---|---|
| Only import payees that are used | on | Money keeps payees long after their last transaction. Leaving this on skips the unused ones |
| Only import categories that are used | on | Money seeds a full category tree whether you use it or not |
| Import closed accounts | on | Closed accounts keep their history and are created closed |
| Import price history | on | Money's own record of what each security was worth, day by day |
| Import exchange rates | on | Historical rates, so past foreign-currency transactions convert the way Money had them |
| Start fresh | off | Removes your existing Monize data before importing. Typed confirmation and password required |

## What is imported

- **Accounts** of every type, with opening balances, currencies, and closed and
  favourite flags. A Money investment account becomes Monize's linked cash and
  brokerage pair, matching how Money itself stores them. Money's watch accounts
  ("Investments to Watch") are created excluded from net worth, since they track
  quotes rather than money you hold.
- **Transactions**, including splits, reference numbers, memos, and the
  cleared/reconciled status of each. Voided transactions are imported as voided
  rather than dropped.
- **Transfers**, using Money's own record of which two rows are the two sides.
  Nothing is matched by guesswork.
- **Loan and mortgage payments**, with the principal leg wired to the loan
  account as a transfer split. Where the payments make it unambiguous, the loan's
  funding account, payment amount and interest category are filled in too.
  Money's **Pmt Num** arrives in the loan register's Ref. num. column.
- **Securities and investment transactions**: buys, sells, dividends,
  reinvestments, share transfers between accounts, and stock splits. Each trade
  puts exactly one row in exactly one cash register, wherever Money put it: the
  account's own cash side for a trade paid out of it, the paying account for one
  funded from elsewhere, and no row at all for a trade that was one line of a
  larger transaction -- there the purchase appears as an investment line inside
  that transaction's splits.
- **Price history and exchange rates**, both additive -- importing twice, or
  importing on top of prices a quote provider already fetched, converges rather
  than duplicating.
- **Scheduled bills** you ticked, created active and set not to post
  automatically, so nothing lands in your accounts without you.

## What is not imported (v1)

- **Budgets.** Money's budget tables have no clean equivalent in Monize's.
- **Savings goals.** No equivalent entity.
- **Classifications** beyond ordinary categories.
- **Attachments** embedded in the file.
- **Categories deeper than two levels** are flattened into `Parent:Child` names;
  Monize's category tree is two levels deep.

## Known limitations

**No merge, no de-duplication.** Version 1 targets a fresh profile. Importing
the same file twice creates the transactions twice.

**Foreign-currency cost basis.** Money stores a foreign holding's cost basis
converted to your base currency at the historical rate, not in the security's own
currency. Monize imports what the file says; a holding bought in a currency other
than your base one can therefore show a cost basis that differs from what you
paid in the original currency. The verification report flags these, and the share
counts themselves are unaffected.

**Two Money codes are still unconfirmed.** Money's `act` 5 and 14 (a
reinvestment variant and a cash corporate action) have never appeared in any file
available to this project, so their handling is inferred. Any transaction mapped
through one carries a note in the report rather than being silently accepted.

**Securities sharing a symbol.** Money allows two funds with the same ticker.
Monize's symbols are unique per user, so the second gets a suffix (`VOO-2`) and a
note in the report -- never collapsed into the first. A security with no symbol
gets a generated placeholder and is excluded from automatic price updates.

## If something goes wrong

Nothing is written unless the whole import succeeds, so a failure leaves your
data as it was and the uploaded file is kept for one more attempt.

| What you see | What it means |
|---|---|
| "That file was written by Money 97 or 98" | Convert it through Money Plus Sunset first (see above) |
| "That file is not a Microsoft Money file" | Wrong file, or the upload was corrupted |
| "That Money file looks incomplete" | The upload was cut short -- try again |
| "Its contents could not be read" | The file decrypted but its internals are damaged. Open it in Money and save a fresh copy |
| "The import stopped responding" | The server restarted mid-import. Your file is still here: press Try again |
| "The uploaded Money file is no longer available" | Uploaded files are kept 24 hours. Upload it again |
| "An import is already running" | Wait for it to finish -- possibly in another tab |

Two self-hosting failures look like the app is broken and are configuration:

- **The upload dies immediately and the backend logs `Request aborted`.** The
  Next.js proxy in front of the API caps a forwarded request body at 10MB by
  default, and *truncates* rather than rejecting anything larger, so nothing
  reports a size problem. `MNY_IMPORT_LIMIT_MB` sizes that ceiling and must be
  set on the **frontend** as well as the backend.
- **The server is killed partway through every attempt.** It is running out of
  memory. A Money file is held in memory while it is read, so the backend needs
  roughly twice the file size available, and the frontend needs another copy
  because the proxy buffers the upload. See `helm/README.md` for the sizing
  rules.

## Accuracy, and how to check it

The verification report is the point. Balances are computed from the Money file
by the same rule Monize computes its own, and share counts are compared against
Money's open tax lots -- so a discrepancy shows up as a number rather than as a
suspicion. If an account does not reconcile, the report names it and says by how
much.

For a deeper look, `npm run mny:inspect -- yourfile.mny` prints what the reader
and mappers make of a file -- accounts, balances, holdings, bill candidates, and
every warning -- without importing anything.

## For developers

- `docs/ms-money-data-model.md` -- the `.mny` format reference: tables, codes,
  and the traps that produce plausible-looking wrong answers.
- `docs/future-plans/mny-import.md` -- design, architecture decisions and the
  task history.
- `backend/src/import/mny/README.md` -- how the pipeline is layered and what it
  refuses to guess at.
