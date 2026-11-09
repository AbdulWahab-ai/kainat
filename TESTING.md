# Kainat test report

Date: 5 November 2026. The suite passed in full on two consecutive runs.

| Layer | Tests | Result | What it covers |
| --- | --- | --- | --- |
| Unit | 28 | Pass | Phone normalisation, number and text parsing, price ranges, city matching, WhatsApp price parsing, date and money formatting, page-routing rules, database upgrades, transactions |
| Integration (API) | 95 | Pass | All 60 API routes. Each is checked for anonymous access (401), wrong role (403), validation errors, state rules, privacy and success paths |
| Smoke (API journey) | 50 checks | Pass | One long buyer-to-supplier-to-admin journey, kept from the first build |
| End-to-end (browser) | 62 | Pass | All 32 screens for every role, on a phone and a desktop, driven in headless Chromium |

## How to run

```powershell
cd D:\Projects\solar-procure
npm test
```

You can also run one layer at a time with `npm run test:unit`, `npm run test:integration`, `npm run test:smoke` or `npm run test:e2e`.

Each test file starts its own server on a free port with a throwaway database, so the tests never touch your real data in `data\app.db`. The browser tests use the Chromium already cached in `D:\DevEnv\caches\playwright`, through the dev-only package `playwright-core`.

## Coverage

**Roles:** signed out, new number without a role, buyer (verified and unverified), supplier (self-signed-up, team-built and unclaimed, invited), admin, and suspended accounts.

**Screens:** every screen is opened for each role on a phone (375 px) and a desktop (1280 px). Each must:
- have no script errors
- show no error page
- not scroll sideways
- give every button, link, input and image a readable name

**Workflows tested through the browser:**
- Sign-in, wrong code, invalid number, sign-up as buyer and as supplier, claiming a team-built shop, guards between roles, switching accounts, signing out, and being signed out by a suspension.
- Supplier: inbox tabs, one-tap in-stock bid, the live bid board with "Beat the lowest", bidding on a free-text request, passing, editing a price with history, hiding an item, adding an item and a new model, quoting by WhatsApp, declining an order with a reason, accepting, dispatching, order messages, chatting from the inbox, profile.
- Buyer: search filters, comparing and sorting, asking for an exact price, posting model and free-text requests (open and sealed), bids arriving live, accepting a bid with token calculation, a new address and a screenshot upload, confirming delivery, flagging a problem, cancelling an order and getting the bids back, inviting a supplier, cancelling a request, chat with photo attachments and unread counts.
- Admin: metrics and price check, building a shop (then the supplier claiming it), duplicate-number error, documents, verification, suspension, catalogue add, approve, merge and reject, resolving a flagged order, request and WhatsApp logs.
- Security and regressions: HTML in names, requests and chat messages is shown as text and never runs; leaving a live screen doesn't pull the user back; fast screen switching never shows the wrong screen; double-tapping submit creates only one bid or order.

**API edge cases:**
- **Sign-in codes:** expired, reused, and replaced codes.
- **Bad input:** forged session cookies, malformed JSON, uploads over 10 MB, and blank or negative numbers.
- **Attachments:** oversized files and wrong file types.
- **Paths:** traversal attempts like `/../server.js`.
- **Privacy:** chat, order, quote and request privacy between businesses.
- **Matching:** city and category rules, "partners only", single-listing requests.
- **Bidding:** open versus sealed, outbid alerts, request expiry, cancellation.
- **Orders:** every allowed and disallowed status change.
- **Admin:** model merges that would collide.

## Bugs found and fixed

Each fix addresses the root cause and has a test that would catch it coming back.

| # | Bug | Effect | Fix |
| --- | --- | --- | --- |
| 1 | Blank numbers like `"  "` were read as 0 | A blank quantity on a quote, or blank token percentage, became zero instead of the default | The number parser now treats blank input as not given (`src/api.js`, `int`) |
| 2 | A buyer allowed to see only a price range could order the listing through the API | The order revealed the supplier's hidden exact price, bypassing price privacy | The server refuses the order and asks for a quote first, whatever the screen shows |
| 3 | Cancelling an order placed from a bid left the request closed, with every bid marked lost | The buyer could never pick another supplier for that request | Declining and cancelling share one "reopen the request" routine. A cancelled bid stays available; a declined one is dropped. An expired request is marked expired rather than reopened |
| 4 | Uploads over 10 MB cut the connection instead of returning an error | The browser showed a vague network failure instead of "Request too large" | The server reads and discards the rest of the upload, then replies 413 with a clear message |
| 5 | A team-built shop's WhatsApp showed waiting requests before the welcome message | Messages read in the wrong order | The welcome is sent first and updated with the number of waiting requests |
| 6 | "1 completed deals" in request messages | Wrong wording | Singular and plural are now handled |
| 7 | Switching screens while one was still loading could let the slower screen draw over the new one | You could see the wrong page; a stale screen could also wire its buttons onto the new screen's form | Each screen may draw only while it is the current navigation. A stale screen stops at once, and live refreshes start only from the screen showing |
| 8 | Item rows on the admin "Build a supplier shop" form had no labels | Screen readers could not name the model, price, stock and token fields | Each field now has a label |

Fixes 4 and 7 were also checked for flakiness by running the suite in parallel several times.

## Known limits

These are not bugs:
- **WhatsApp and SMS are simulated.** Sign-in codes show on screen.
- **No payments or escrow.** Token money is a screenshot the parties check themselves.
- **Not tested on real phones or in Safari.** The browser tests run Chromium at phone and desktop sizes.
- **No load testing.** SQLite is fine for a pilot with dozens of businesses, not for thousands at once.
