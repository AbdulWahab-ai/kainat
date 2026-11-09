# Kainat test report

First written 5 November 2026. Updated 9 November 2026 for notifications, ratings and security hardening: the full suite of 308 tests and checks passes.

| Layer | Tests | Result | What it covers |
| --- | --- | --- | --- |
| Unit | 39 | Pass | Phone normalisation, number and text parsing, price ranges, city matching, WhatsApp price parsing, date and money formatting, page-routing rules, database upgrades, transactions, Pakistan time and quiet hours, alert links |
| Integration (API) | 144 | Pass | All 73 API routes. Each is checked for anonymous access (401), wrong role (403), validation errors, state rules, privacy and success paths. Also every notification rule and scheduled job, using a server clock the tests move forward |
| Smoke (API journey) | 50 checks | Pass | One long buyer-to-supplier-to-admin journey, kept from the first build |
| End-to-end (browser) | 75 | Pass | All 35 screens for every role, on a phone and a desktop, driven in headless Chromium |

## Notifications and ratings (added 9 November)

The test server starts with test hooks: `/api/test/clock` moves its clock forward, and `/api/test/tick` runs the scheduled jobs on demand. Quiet hours are off by default so tests behave the same at any time of day; the quiet-hours tests switch them on.

**Notifications:**
- **In-app list and bell:** links to the right screen, unread counts, mark read.
- **Preferences:** defaults, validation, switching a group off for WhatsApp. Orders can't be switched off.
- **Batching:** the first bid goes out at once, and later alerts within 15 minutes arrive as one summary. Urgent alerts are never batched.
- **Quiet hours:** a request at 11 pm Pakistan time waits until 8 am, while a new order still goes through.
- **Matching waves:** wave 1 is the in-stock suppliers plus the best 5. Wave 2 goes out after 30 minutes only if fewer than 2 bids came in. The no-bids notice comes at 2 hours. Widening works from the app and from the WhatsApp button.
- **Daily cap:** 10 WhatsApp alerts a day for requests where the supplier doesn't hold the exact model. It resets after 24 hours.
- **Scheduled jobs:** the closing notice and expiry notice (each sent once), the 4-hour order reminder (once), auto-delivery after 7 days, and the morning price check (once a day from 8 am, skipping suppliers who already confirmed). Every job is checked to change nothing when run twice.

**Ratings:**
- **Who can rate:** only the two sides, only after delivery, only 1 to 5 stars. Tags are filtered by side.
- **Blind reveal:** ratings show once both sides have rated, and can be edited until then. The first rating nudges the other side without saying what it was. A single rating is revealed after 14 days.
- **Time limits and problems:** a flagged order holds ratings until it is resolved. Rating closes after 30 days, and each side gets one reminder after 3 days.
- **Replies:** once, only by the business that was rated, only after the rating is shown.
- **Scores:** need 3 ratings, and count only the latest rating from each partner.
- **WhatsApp star taps:** set the stars and keep the tags and comment from the app.
- **Admin:** the low-ratings filter, and hiding a comment while its stars still count.
- **Browser:** the bell, alert settings, the rating form and replies, scores on profiles and offers, the "Best rated" sort, widening a request, and the admin ratings and notification log.

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

## Security hardening (added 9 November)

- **Sign-in codes:**
  - Production never returns the code, and sends it through the configured gateway.
  - Without a gateway, sign-in refuses to start.
  - Wrong codes are limited to 5, with the tries left shown.
  - Code requests are limited per number (30 seconds apart, a few an hour) and per network address.
- **Sessions:**
  - They end after 30 days without use and 90 days after sign-in, and stay alive while used.
  - Sign out everywhere ends every session for the number.
  - Cookies are Secure only behind a trusted HTTPS proxy.
  - The cleanup job removes old code requests and sessions.
- **Uploads:** a script renamed as an image and a PNG named as a PDF are refused; real images and PDFs are accepted.
- **Phone numbers:**
  - Refused (422, with the role and attempt count the warning needs) in chat, order messages, requests, order addresses and notes, and quote notes. "Send without the number" saves the message masked and tells both sides.
  - Refused outright in business details, ratings and replies.
  - Hidden in decline reasons and flagged problems.
  - Not read as a price when sent by WhatsApp.
  - Never shown to another business, even after an order.
  - Attempts are counted for the admin without storing the number.
- **Detector:** 28 cases, covering numbers in every common form and prices that must not match.
- **Browser:**
  - the typing hint, the warning dialog for each side, Edit and Send without the number
  - hidden numbers on order and supplier pages
  - sign out on all devices
  - a production sign-in page without demo accounts

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

Found while building notifications and ratings (9 November):

| # | Bug | Effect | Fix |
| --- | --- | --- | --- |
| 9 | Only normal alerts counted toward the 15-minute batch window | A buyer could get the first bid and the second bid as two separate WhatsApp messages seconds apart | Any WhatsApp alert in the last 15 minutes, urgent ones too, starts the batch window |
| 10 | The scheduled price check skipped shops the team built but the supplier had not claimed yet | Suppliers who only use WhatsApp would never get the morning price check | The price check goes to every active supplier with listings, claimed or not |
| 11 | A WhatsApp star tap that completed both ratings replied "stays hidden until they rate too" | Wrong message: both ratings were already shown | The reply says whether the ratings are now shown |
| 12 | The "rated your deal" message doubled the punctuation after a comment | Read as `…day.”.` | The comment is quoted at the end of its own sentence |
| 13 | The browser tests' toast check could read the previous toast while it was still on screen | Tests failed now and then, depending on timing | Each toast carries a number; the check waits for a newer one |
| 15 | Masking a WhatsApp link hid the number inside it first, leaving half the link behind ("[number hidden] hidden]") | A masked message looked broken | Links are hidden before numbers; a unit test covers it |
| 14 | The morning price check ran whenever the server first ran its jobs after 8 am | A server restarted at 2:30 pm sent "Good morning" in the afternoon | The check runs only between 8 and 11 am Pakistan time; otherwise it waits for the next morning |

## Known limits

These are not bugs:
- **WhatsApp and SMS are simulated.** Sign-in codes show on screen.
- **No payments or escrow.** Token money is a screenshot the parties check themselves.
- **Not tested on real phones or in Safari.** The browser tests run Chromium at phone and desktop sizes.
- **No load testing.** SQLite is fine for a pilot with dozens of businesses, not for thousands at once.
