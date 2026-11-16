# Frontend: PWA, push notifications and Web Share Target

Push subscriptions and the permission prompt, the notification badge, and the Web Share Target stash. Read this before touching `lib/push.ts`, `public/sw.js`, the share inbox or anything under `app/share`.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## A push subscription belongs to an account; `localStorage` belongs to an origin

`monize.push.registeredEndpoint` records the endpoint this browser registered
**and whose registration it was** (`rememberRegisteredEndpoint(userId,
fingerprint)`), because two people share one browser profile: with the owner
missing, the second account signing in saw a subscription it had no server row
for, read it as a revocation and unsubscribed the browser -- taking push away
from the first account, whose device list still showed the row as active.
`classifyPushRegistration` therefore takes the marker *and* the reader's id, and
answers `foreign` for a marker somebody else wrote -- **whichever endpoint it
names**: read as a rotation, a foreign marker naming a different endpoint had the
panel register a device for a reader who never asked for notifications, passing
the permission gate only because the other account had granted it. The panel acts
on nothing there, because neither repair (release, or re-register) is the reader's
to make, and sign-out leaves such a subscription alone for the same reason. A
value in the pre-owner format, or one with no reader identity, reads as "no
information" -- which errs toward doing nothing.

**Sign-out holds this browser's device; it releases only when the hold is not
confirmed** (INV-PUSH-011). `AppHeader.handleLogout` calls `holdPushForSignOut`:
it finds this browser's row by fingerprint, asks the server to hold it, and only
when that request succeeds keeps the subscription and flags the marker `held`
(`markRegisteredEndpointHeld`). Every other outcome -- no row, a refusal, an
older backend's 404, a delegate session's 403, the 1.5 s bound elapsing -- runs
the full release, because a subscription left in a browser whose row still
delivers would show the departing account's notifications to the next person
there. `usePushResumeOnSignIn` (mounted in `SwipeShell`) resumes it: only for a
held marker naming the signed-in user, with permission already granted, by
re-posting the subscription through the ordinary subscribe. A changed key or a
4xx refusal releases the subscription AND retires the held row; a 5xx, a 401 or
no answer keeps the hold for the next sign-in; a rotated endpoint retires the old
row before the new one is posted, so it does not count against the device cap.
The hook forgets its attempt on sign-out, because the shell stays mounted across
a client-side sign-out and sign-in. An ordinary page load without a held marker
makes no request. `PushEnableBanner`
treats a held marker naming the reader as "not yet known" until the resume
settles, so it does not flash Enable. Account deletion (`DangerZoneSection`)
keeps `releasePushForSignOut`, and a session that merely expires touches push not
at all.

**Replacing this browser's endpoint means retiring the row for the one it
replaced** (`retireServerRowFor`). Nothing else ever would: a row is retired by a
delivery's own 404, and nothing delivers to an endpoint that no longer exists --
so each rotation, and each Enable on a browser that does not expose
`options.applicationServerKey`, left a permanent undeliverable "device" in the
user's list holding one of their `MAX_LIVE_DEVICES_PER_USER` slots. That cleanup
is also what makes the conservative reading of an unknown key affordable: an
unreadable key is treated as a mismatch, because a silently undeliverable
subscription is worse than a fresh endpoint.

Whatever `getPushSupport` reads is the same shape of problem in time rather than
identity: `Notification.permission` and "is this the installed iOS app" are
states the user changes *elsewhere* and then comes back, so the panel re-reads
them when the page becomes visible. Read once on mount, it kept telling the user
the browser had refused after they had allowed it, with the Enable button hidden.

## A shared file has one accept list and one reader -- `share-target.ts`, `share-inbox.ts`

The Web Share Target puts Monize in the OS share sheet, and the two halves of it
each live in exactly one file:

- **`lib/share-target.ts` is the accept list, the limits and the
  classification.** `SHARE_TARGET_ACCEPT` is *derived* from
  `ACCEPTED_ATTACHMENT_TYPES` plus `SHARE_STATEMENT_EXTENSIONS`, so the share
  sheet cannot offer a type the upload then refuses (nor hide one it would take);
  the per-file and per-share caps come from `MAX_ATTACHMENT_BYTES` and
  `MAX_ATTACHMENTS_PER_TRANSACTION` rather than being written again. `.mny` is
  deliberately absent -- a Money file is a whole profile behind a password prompt
  and a wipe confirmation.
- **`lib/share-inbox.ts` is the only reader of the stash.** Nothing else names
  `SHARE_CACHE_NAME` or builds a stash key; a second reader is how the key shape
  and the worker's writer drift apart. Every function treats an unusable Cache
  API as an *empty inbox* and resolves rather than rejecting, which is what lets
  `ShareStashSweeper` call it from an effect without a guard -- and why a
  `catch` around it in a reader would put a `setState` on the synchronous path
  the `react-hooks/set-state-in-effect` rule forbids.

**A bundle belongs to the first authenticated reader that observes it, and the
reader's id is a required argument.** The worker cannot decide whose share it is
-- a share can arrive with nobody signed in, which is the whole point of the
logged-out resume -- so `listSharedBundles(viewerUserId)` and
`readSharedBundle(id, viewerUserId)` stamp `ownerUserId` on an unclaimed index
and treat a bundle owned by anybody else as absent. **Listing claims too**: a
share the sharer was merely notified about is already theirs, and it is exactly
the one nothing else ever observed. Clearing the stash on `logout` is a sweep,
not the access rule -- two people share a browser profile, and a session that
simply expired never ran `logout`, which is the same reasoning as the
push-registration marker's owner. The id is **required**, not optional, because
an omitted argument is silently indistinguishable from "everyone's": a caller
that has not resolved the reader yet reads nothing and shows its loading state
(`src/app/share/page.tsx`, `useSharedFilesHandoff`), rather than claiming a
share on behalf of whoever the app is still fetching. INV-SHARE-005.

**A sweep is not an observation, so it takes no reader.** `ShareStashSweeper`
(`components/share/ShareStashSweeper.tsx`) is a null-rendering component in the
shell that runs `purgeExpiredSharedBundles` on every navigation but `/share`,
where an expired bundle stays readable so the review screen can say "expired"
rather than "nothing here". It is what is left of `ShareInboxNotice`, a banner
offering a Review link that dead-ended on exactly the share the user had just
routed to the assistant; the UI was redundant, the sweep is one of the three
mechanisms behind INV-SHARE-003, so it outlived the banner rather than being
deleted with it. Do not give it an auth gate copied from the banner: the banner
waited for a reader because listing also CLAIMS, and a sweep decides on
`createdAt` alone.

**A destination is offered only when it can actually accept the share, and it
asks the destination's own validators.** The assistant sits beside the
transaction form and the import wizard on the review screen, gated on two
questions: `useAiConfigured()` (a provider that can answer -- see "A control is
not offered when nothing can answer it" in `docs/frontend/ui-conventions.md`),
and `assistantAcceptsFiles` (`lib/ai-attachments.ts`), which runs the chat's own
`validateFile`/`validateAddition` over the exact set. Re-stating the caps here
would be a second copy that drifts, and they genuinely differ: the stash holds
10 files at 10 MB, the assistant takes 5 at 5 MB and cannot read OFX, QFX or
QIF, so a share the wizard imports happily is often one the chat would refuse
file by file. All-or-nothing, because staging the readable subset would send the
assistant part of what the user shared and say nothing about the rest. The
hand-off is the wizard's: `/ai?share=<id>`, the page reads the bundle as the
signed-in reader, and the stash is discarded only once `ChatInterface` reports
the bytes staged (`onInitialFilesStaged`) -- dropping it on the way in would
leave the user with neither the share nor the attachments. Staged, never sent:
the user still presses send (INV-SHARE-002).

**Do not classify a shared file with the import wizard's `detectFileType`.** That
function falls through to `qif` for every extension it does not recognise, which
is right for a picker (the user chose the file) and wrong for a share sheet (the
OS chose it, so anything outside the accept list must be refused with a reason
rather than handed to the QIF parser). `classifySharedFile` is the share path's
rule and answers `null` for exactly that case.

**`public/sw.js` cannot import any of this**, so it repeats the paths, keys,
limits and accept lists as literals and `src/test/sw-share-target.test.ts`
asserts the two agree -- the mirroring discipline `sw-offline.test.ts` already
applies to the boot palette. It also reads the worker's own
`classifySharedFile` out of the sandbox and compares it, case by case, against
the app's.

**A refused file stays on the list.** The worker records the reason and discards
the bytes, so the review screen can say which of the files the user picked was
not used and why; an accepted file whose bytes were later evicted is reported as
*unavailable*, never silently dropped from a list that would then look complete.
Those are two different states and the copy for each says so.

**An automatic hand-off makes reference data a prerequisite, not a late
arrival.** `useSharedFilesHandoff` drives the import wizard from the shared files
on mount, and the wizard matches the file's categories against the user's
categories, its symbols against their securities and its filename against their
accounts. A human picking a file cannot realistically get ahead of those five
parallel requests; a hand-off that fires on mount loses that race every time --
and a failed category match is not neutral, it is an offer to **create** a
category the user already has. So the wizard exposes `dataLoaded` and the
hand-off waits for it, claiming its one-shot ref only once it actually proceeds.
A load that failed leaves `dataLoaded` false and the bundle in the stash, which
is the honest outcome: the files are offered again rather than matched against
nothing. `src/app/import/share-handoff.test.tsx` holds the ordering with deferred
requests, and fails if the gate is removed.

**The kind a shared file is comes off the entry the worker wrote, never
recomputed from the `File`.** The review screen's destination and the glyph in
its list both read `entry.kind`; deriving it a second time from the rebuilt
`File` is how a row drawn as a statement comes to offer an attachment's
destination. `null` there means the worker never classified it, so the file is
not usable and the screen says exactly that rather than calling the share
mixed.

**Decisions recorded when the share target shipped (Phase 1).** The stash
lifetime is one hour. A lone CSV is offered to Import; the review screen does
not ask whether it is a bank statement or an investment export, the wizard's
mapping step does. The share sheet is documented as Android only; desktop
Chromium's installed-app share target works through the same code and stays
unpromised. Not built, each its own proposal: attaching a shared file to an
existing transaction (a transaction picker), and offering the document scan on
the review screen before the New transaction destination (the scan pipeline
exists; a shared file is staged as a plain file with no original, exactly as an
unscanned upload is). Send to AI Assistant has shipped: `/share` routes to
`/ai?share=<id>` with the same hand-off the wizard uses.

## The notification permission is asked for once, from a click

`Notification.requestPermission()` appears in exactly one file -- `lib/push.ts`,
reached through `enablePushOnThisDevice` -- and
`lib/push-permission-request.guard.test.ts` fails on a second call site. The rule
is not politeness, it is what works: **there is no way to grant this permission at
install time** (no manifest field, no API), and a request without a user gesture
is refused rather than shown -- Firefox has required one since 72, Chrome quiets
the prompt for origins with a poor grant rate, and iOS shows it only inside an
installed web app. A permission an origin loses this way cannot be asked for
again, which is why the news-site pattern (ask on page load) is the one shape this
must never take.

So "install with notifications" is really **ask at the right moment, with a
button**, and `pushPromptState` (`lib/push.ts`) decides that moment.
`PushEnableBanner` renders its three answers app-wide, and two of them carry no
button because nothing a button could do would help: an iPhone in a Safari tab
needs the Home Screen app first, and a browser already refusing can only be
undone in its own settings -- **iOS Settings, then Notifications, then Monize**
for an installed app, not any site settings. Those two states are exactly what
the product had nothing to say about, and the reported experience was a user
deleting the PWA to find out.

Two mechanics that keep it honest. `handleEnable` is **not** an `async` function
in either surface: iOS spends the click's transient activation on the first
suspension, so the request has to be the first thing the handler does -- written
`async () => { setBusy(true); await enable() }` it asks for a permission the user
is then told they did not grant, with no prompt ever shown. And the dismissal is
remembered per account **and** per kind (`monize.push.promptDismissed`): the
account for the reason the registered-endpoint marker carries one, and the kind
because waving away the offer says nothing about wanting to know, later, that the
browser has started blocking Monize.

## A notification's `badge` is a mask, its `icon` is a picture

Chrome on Android draws `showNotification`'s `badge` by keeping the image's
**alpha channel**, discarding the colours and tinting the shape that is left into
the status bar and the toolbar. So the alpha channel has to *be* the glyph, and
an image that is opaque everywhere is a request to draw a filled square -- which
is what shipped, because `PUSH_BADGE` pointed at `icon-maskable-192x192.png`, and
a maskable icon is opaque edge to edge by definition of that purpose. The
notification body's `icon` is the opposite -- a picture, drawn in colour -- which
is why the drawer looked right while the toolbar showed a block.

The badge is therefore its own asset: `public/icons/badge-monochrome.png`, white
on transparent at 96x96 (24dp at the densest screen Chrome asks for), generated
from the brand mark by `frontend/scripts/build-notification-badge.mjs`, and never
taken from `buildManifest`'s icon list. `src/test/notification-badge.test.ts`
fails on a fully opaque badge, on a badge borrowed from an app icon, and on a
committed PNG that has stopped matching the logo it is generated from.
