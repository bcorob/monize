# README pictures

Playwright specs that fill a running Monize instance with showcase data and then
photograph it: the PNG screenshots and the three GIFs in `docs/images/readme/`.
They are not part of the test suite. `playwright.config.ts` only looks in
`e2e/tests`, so none of this runs there; `playwright.readme.config.ts` runs it.

## What it produces

All pictures are dark mode with the default palette, except `theme-msmoney.png`.

Desktop, 1600x1000:
`dashboard`, `transactions`, `transactions-calendar`, `accounts`,
`account-chequing`, `account-mortgage`, `account-asset`, `account-loan`,
`account-credit-card`, `investments`, `investments-calendar`, `security-detail`,
`bills`, `budgets`, `reports`, `report-income-vs-expenses`,
`report-tag-breakdown`, `report-foreign-fees`, `net-worth`, `monte-carlo`,
`budget-wizard`, `rules`, `rule-editor`, `tags`, `payee-detail`, `category-detail`,
`institutions`, `attachment-preview`, `notifications-settings`,
`theme-msmoney`.

Phone, 390x844 at 2x with touch:
`mobile-dashboard`, `mobile-transactions`, `mobile-calendar`, `mobile-menu`,
`mobile-investments`, `mobile-account-mortgage`, `mobile-bills`,
`mobile-report`, `mobile-budget`, `mobile-budget-wizard`.

GIFs, from 1440x900 (phone: 390x844) screen recordings:
`tour.gif` (dashboard, transactions, calendar, investments), `rules.gif` (build a
rule, test it on existing transactions, cancel), `mobile.gif` (drawer, a swipe
that turns a register page, a swipe to the next view).

| File | What it does |
|---|---|
| `01-seed.spec.ts` | Fills the gaps in the demo data through the API (see below). |
| `02-desktop.spec.ts`, `03-desktop-features.spec.ts` | The desktop PNGs. |
| `04-mobile.spec.ts` | The phone PNGs. |
| `05-recordings.spec.ts` | Records the three flows to `e2e/readme-recordings/*.webm`. |
| `make-gifs.mjs` | Turns the recordings into GIFs (ffmpeg, two-pass palette). |
| `optimize-pngs.mjs` | Recompresses the PNGs without changing a pixel (ImageMagick). |

## Prerequisites

1. A Monize instance that holds the built-in demo data, for example
   `docker compose -f docker-compose.prod.yml -f docker-compose.demo.yml up -d`,
   which seeds the demo user (its login is `DEMO_USER_EMAIL` and
   `DEMO_USER_PASSWORD` in `frontend/src/lib/demo-credentials.ts`). In demo mode
   the app shows a yellow "Demo Mode" bar and pre-fills the login form; to leave
   them out of the pictures, restart the backend with `DEMO_MODE=false` once the
   data is seeded.
   Any other instance with that data and that user works too.
2. Raise the rate limits on that instance the way `docker-compose.e2e.yml` does,
   `RATE_LIMIT_MAX=100000`. The login endpoint allows five attempts per fifteen
   minutes and the API a hundred requests a minute per address, which a run of
   this size passes.
3. A Chromium for Playwright. Either `npx playwright install chromium`, or point
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at a Chromium already on the machine.
4. `ffmpeg` for the GIFs; ImageMagick (`magick` or `convert`) is optional and
   only shrinks the PNGs.
5. `cd e2e && npm ci`.

The backend must be able to reach the internet for company and payee logos
(without it every logo is a letter avatar), and the exchange-rate provider must
be reachable, otherwise USD holdings show as incomplete.

## Commands

```bash
cd e2e
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run readme:screenshots   # seed, then every PNG and the recordings
npm run readme:gifs                                                             # recordings to GIFs
npm run readme:optimize                                                         # optional: smaller PNGs
```

`readme:screenshots` runs the five spec files in name order on one worker, so
the seed is always first. A run starts with one sign-in through the login form
and shares that session between the specs; the "Turn on notifications?" prompt
is dismissed by writing the same record the app writes when a reader clicks
"Not now". The raw recordings land in `e2e/readme-recordings/` (git-ignored)
and each GIF starts where its flow does, not where the recording does.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | The frontend to photograph. |
| `README_SHOTS_EMAIL` | `DEMO_USER_EMAIL` | The demo user's email. |
| `README_SHOTS_PASSWORD` | `DEMO_USER_PASSWORD` | The demo user's password. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | unset | A Chromium to use instead of Playwright's own. |

## What the seed adds, and that it is safe to repeat

The demo data has no tags, rules, budget or loans beyond the mortgage. `01-seed`
adds, each looked up by name and created only when absent, so a second run
changes nothing:

- Dark mode, the default palette, and the dashboard layout and "all upcoming"
  list, through the user's own preferences. The getting-started card and the
  "What's new" dialog are switched off the way the app lets a user do it.
- Six tags (two of them `key:value`), placed on transactions; six transaction
  rules, one of them switched off.
- The monthly budget, built from the budget wizard's own analysis.
- A mortgage rate change and two overpayment scenarios; a car loan linked to the
  Vehicle (which gets four value adjustments) and a line of credit; a statement
  cycle (closing and due day) on the Visa.
- A hotel paid for in euros on the Visa, at a rate typed in, with a receipt
  attached (drawn locally, nothing is downloaded); contact details on a payee.
- A monthly fund purchase and a bill every four weeks; manual country and asset
  class splits on the funds; two saved Monte Carlo scenarios with a fixed seed.
- Calendar day notes in the month that holds transactions: this month once the
  tenth has passed, otherwise last month.

Sector breakdowns of a fund cannot be seeded through the API (the quote
provider fills them in), so the spec leaves them alone rather than writing to
the database. After the seed it asks the app to recalculate its net worth
snapshots, so they are built from the ledger and the exchange rates the
instance holds.

The demo user is left in dark mode. `theme-msmoney.png` switches the palette and
puts the default back, even when the picture fails.
