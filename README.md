# Kainat

Kainat is a solar equipment procurement marketplace. This is a working local MVP of what the PRD describes. Installers post a request or compare live listings. Suppliers who have that model in stock are alerted at once and can bid with one tap. Bids update live, and buyer and supplier can chat in the app to settle details. Every deal is recorded as trade history.

The colors follow the warm palette of Claude's website: an ivory background, a clay-orange accent and near-black text. The layout, fonts and icon shape are unchanged from the original design.

## Run it

Open **http://localhost:8090**.

The server runs in the background. To start or stop it:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Projects\solar-procure\start.ps1
```

```powershell
powershell -ExecutionPolicy Bypass -File D:\Projects\solar-procure\stop.ps1
```

It needs only Node 22.13 or newer (installed at `D:\DevEnv\tools\node`). There are no packages to install: the server uses Node's built-in HTTP server and built-in SQLite. Data lives in `data\app.db`.

To wipe everything back to the demo data, stop the server, then run `npm run reset` and start it again.

## Backups

The `data` folder (database, uploads, logs) is never committed to git. Back it up with `npm run backup`. This is safe while the server runs. It writes a checked copy to `D:\Backups\kainat`, keeping the newest 30, and to `OneDrive\Backups\kainat`, keeping the newest 14, so one copy leaves the PC. Set `BACKUP_DIRS` (separated by `;`) to choose other folders.

To back up automatically every day at 21:00, run this once. If the PC is off at that time, the backup runs when it is next on.

```powershell
powershell -ExecutionPolicy Bypass -File D:\Projects\solar-procure\scripts\schedule-backup.ps1
```

To restore:
1. Stop the server.
2. Copy `app.db` from a backup folder into `data\`, replacing the old file. Delete any `app.db-wal` and `app.db-shm` there.
3. Copy the backup's `uploads` folder into `data\`.
4. Start the server again.

To test everything, run `npm test`. It runs unit, API integration, smoke and browser end-to-end tests (277 tests and checks) against throwaway databases, so your data is untouched. [TESTING.md](TESTING.md) lists what is covered and the bugs the tests found.

The project folder is still named `solar-procure`, so existing shortcuts and scripts keep working.

## Demo accounts

The sign-in page lists them, so you can tap one. There is no real SMS or WhatsApp provider, so the 6-digit code is shown on screen. Any other mobile number starts a new sign-up.

| Number | Account | What to try |
| --- | --- | --- |
| 0300 1111111 | Al-Noor Solar Imports, importer | In-stock match on SunPeak's request: tap "Bid Rs 325,000 now", then watch the live board |
| 0300 2222222 | Sun City Traders, Hall Road distributor | Gets an outbid alert on WhatsApp; beat the lowest bid; a chat with SunPeak is already going |
| 0300 5555555 | Abbas Solar Store, Sahiwal wholesaler | Out-of-city supplier |
| 0300 6666666 | New Era Energy | A shop the team built that is not claimed yet: shows "Your shop is ready" |
| 0321 1111111 | SunPeak Energy, verified installer | Live bids on a request for the Growatt 10 kW, an ongoing chat, "Accept bid" |
| 0321 2222222 | Green Roof Solutions, installer | Has an order waiting for Al-Noor |
| 0321 3333333 | Bright Solar Works, not verified | Sees price ranges until it requests a quote |
| 0300 0000000 | Kainat team | Admin console |

All businesses, people and prices are made up for the demo.

## What is built

**Matching and live bidding**
- **In-stock matching.** When a buyer posts a request for a model, every supplier with that model in stock gets an in-stock match alert. The alert shows their own stock and shop price, in the app and on WhatsApp.
- **One-tap bid.** "Bid Rs 325,000 now" in the inbox, or the matching WhatsApp button, places a bid at the shop price. "Bid lower" lets them undercut.
- **Open or sealed.** The buyer chooses. With open bidding, suppliers see the lowest bid and their place. When someone beats them they get an outbid alert with a "Beat the lowest" shortcut. With sealed bids, suppliers see only their own.
- **Live board.** Bids refresh every few seconds on both sides. The buyer sees each bid's best-price badge, how many times it was revised and how far it dropped. "Accept bid" turns it into an order.
- **In stock, not bid yet.** Under the bids, the buyer sees in-stock suppliers who have not bid. They can order from them directly or ask them to bid.

**Notifications**
- **One engine for every alert.** Requests, bids, outbid alerts, orders, chat, price checks and ratings all go through it. Every alert shows under the bell in the app, and goes to WhatsApp unless the business switched that type off. Orders always go to WhatsApp.
- **Urgent alerts go out at once.** These are new requests, the first bid on a request, outbid alerts and order updates. Other alerts wait if the business had a WhatsApp alert in the last 15 minutes, then arrive together as one summary message.
- **Quiet hours.** The default is 10 pm to 8 am, Pakistan time, and each business can change it in Profile. WhatsApp alerts wait until morning; new orders still go through.
- **Matching in waves.** Suppliers with the exact model in stock, plus the 5 best other matches, get a new request at once. If fewer than 2 bids arrive in 30 minutes, the rest of the city gets it. After 2 hours with no bids, the buyer is told and can widen it to suppliers in other cities.
  - Suppliers are ranked by stock, past deals with this buyer, how often they answer requests, fresh prices and rating.
  - Suppliers get at most 10 WhatsApp alerts a day for requests where they don't hold the exact model.
- **Scheduled jobs**, every minute:
  - a notice 6 hours before a request closes, and when it expires
  - a reminder to the supplier when an order has waited 4 hours
  - orders count as delivered 7 days after dispatch
  - the morning price check at 8 am, sent only to suppliers who haven't confirmed their prices that day
- **Admin notification log**, with counts of what was sent, batched, held for quiet hours or switched off.

**Ratings**
- **Who rates.** After delivery, buyer and supplier rate each other: 1 to 5 stars, quick tags and an optional comment. They can rate in the app, or by tapping a star on WhatsApp.
- **Blind until both rate.** Neither side sees the other's rating until both have rated, or 14 days have passed. A rating can be changed until then. Rating closes 30 days after delivery.
- **Scores.** A score shows from 3 ratings. Only the last 12 months count, and only the latest rating from each partner. Scores appear on offers, bids, supplier profiles and the supplier's request inbox. Buyers can sort offers by "Best rated".
- **Replies and moderation.** The rated business can reply once in public. Ratings on an order with a flagged problem wait until it is resolved. The Kainat team sees low ratings and can hide an abusive comment, but never change the stars.

**Chat**
- **Buyer and supplier chats.** They talk without sharing phone numbers. A chat can be general or about one request, and every bid is posted into the request's chat so the negotiation stays in one thread.
- **Photos and PDFs.** Share site photos, spec sheets or datasheets up to 6 MB.
- **Unread counts.** The Chats tab shows unread chats. The other party gets one WhatsApp nudge per batch of unread messages, so a busy chat doesn't flood WhatsApp.
- **No cold pitching.** Buyers can message any supplier. Suppliers can message only buyers who sent them a request or ordered from them.

**Suppliers**
- **Claim a shop the team built.** The supplier signs in with their number, checks the shop, taps once, and lands on waiting buyer requests.
- **Request inbox.** This is the home screen. It shows matching buyer requests, orders to confirm, and the daily "same prices as yesterday?" check.
- **Send quote.** The model comes from the request, so the supplier only enters price, stock, token percentage and delivery days. The "also show to other buyers" switch saves the quote as a listing, and the supplier chooses whether others see the exact price or a range.
- **My shop.** Each item shows its source (built by the team, from a quote, or added by hand), how fresh its price is, edit and hide controls, and price history. A manual add, including submitting a new model, is kept as a fallback.
- **Simulated WhatsApp.** Requests arrive with "Send price" and "Not in stock" buttons. A reply such as `305000 8 20` or `3.05 lakh 8` becomes a quote, then "Yes, add it" puts it in the shop. The morning price check, and accepting or declining an order with a reason, all work from the chat.

**Buyers**
- **Search.** Filter by category, city and in-stock, and see the lowest price for each model.
- **Compare.** Listings and the buyer's own quotes appear side by side. Each shows the supplier's deal count, a "You: N deals" badge, a warning for new suppliers, freshness, token percentage and lead time. You can sort by lowest price, most deals or fastest.
- **Post a request.** Ask for a model, or describe what you need ("5 kWh lithium battery"). Send it to all matching suppliers in a city, to past partners only, or to one listing to get its exact price. Requests close after 48 hours.
- **Invite my own supplier.** The supplier gets the request on WhatsApp and can quote without the app.
- **Order.** The price is locked on sending. Pick a saved address or add a new one, add a needed-by date and a note, see the token amount calculated, and upload a token-money screenshot (image or PDF).

**Both sides**
- **Order page.** A status timeline (sent, accepted, dispatched, delivered), a message thread, token proof, and "Flag a problem".
- **Trade history.** Counts update on delivery and feed the badges.
- **Privacy rules.** Contact details show only once the two sides have an order. Exact prices show only to verified buyers and past partners, unless the supplier makes them public.

**Admin console** (sign in as 0300 0000000)
- **Overview.** The PRD's success metrics, plus a button that sends the morning price check.
- **Build a supplier shop.** Business details plus first items. The supplier gets a WhatsApp message, and matching open requests are sent to them at once.
- **Suppliers and buyers.** Set document status, mark verified, suspend or reactivate.
- **Requests.** Highlights requests that matched no supplier, which shows a gap in supply.
- **Orders.** Filter to flagged problems and resolve them with a note.
- **Catalogue.** Approve, reject or merge models that suppliers submit, and add models.
- **WhatsApp log.** Every message sent or received.

## Not built yet

These are later phases in the PRD:
- **Real SMS or WhatsApp delivery.** Needs the WhatsApp Business Platform, with Meta approving the message templates.
- **Reading forwarded price lists, photos and voice notes.**
- **Escrow and payments.**
- **Dollar-linked repricing and staff seats.**
- **Packing-list import, ratings, logistics and Urdu screens.**

## Code map

- `server.js` serves the app and the API.
- `src/db.js` holds the schema and SQLite helpers. `src/seed.js` holds the demo data.
- `src/api.js` holds every API route and its role check, the matching waves and the scheduled jobs.
- `src/notify.js` is the notification engine (in-app list, WhatsApp delivery, batching, quiet hours). `src/ratings.js` holds the rating rules. `src/clock.js` is the shared clock, which tests can move forward.
- `public/js/` holds the screens: `auth.js`, `supplier.js`, `buyer.js`, `chat.js`, `shared.js` and `admin.js`. `core.js` holds the router, shell, live polling and helpers.
- `tests/unit`, `tests/integration` and `tests/e2e` hold the test suites; `tests/helpers/server.js` starts a throwaway server for them. `scripts/smoke-test.js` is the original API journey test. `scripts/reset.js` wipes the data. `scripts/backup.js` and `scripts/schedule-backup.ps1` handle backups.

## Security

**Sign-in codes**
- **Development:** the code is shown on screen and the demo accounts are listed. This is the default.
- **Production** (`NODE_ENV=production`):
  - Codes are never returned to the browser and demo accounts are hidden.
  - Codes go through an SMS or WhatsApp gateway set by `SMS_GATEWAY_URL` (and `SMS_GATEWAY_TOKEN`). The gateway receives `{ to, channel, text }`.
  - Without a gateway, sign-in refuses to start rather than pretending a code was sent.
- **Limits:** 5 wrong tries per code. Codes for one number are at least 30 seconds apart, with at most 6 an hour. At most 30 codes an hour come from one network address. Override with `OTP_MAX_PER_HOUR`, `OTP_MIN_GAP_SEC` and `OTP_MAX_PER_IP_HOUR`.

**Sessions**
- **Expiry:** a session ends after 30 days without use, and always 90 days after sign-in.
- **Sign out everywhere:** available in Profile.
- **Secure cookies:** cookies are marked `Secure` over HTTPS. Behind a proxy such as Caddy or Nginx, set `TRUST_PROXY=1` so the forwarded protocol and address are trusted.

**Uploads**
- Uploads are checked by their real content (PNG, JPEG, WebP or PDF), not by the name or the declared type.

**Phone numbers stay on Kainat**
- **Never shown:** numbers are not shown to other businesses, even after an order. Each business and the Kainat team still see their own.
- **Blocked or hidden in anything the other side reads:**
  - chats, order messages, request descriptions, order addresses and notes, quote notes
  - decline reasons and flagged problems
  - business details, ratings and replies
  - WhatsApp replies
- **What senders see:**
  - a warning as they type
  - when sending, an explanation that the risk goes with a conversation that moves outside Kainat, and that it can harm a supplier's profile
  - a choice to send the message without the number
- **What the Kainat team sees:** attempts are counted per business, without storing the number itself. Repeat attempts lower a supplier's place in request matching, and the admin console shows the counts.
- **One detector:** the same detector (`public/js/phone.js`) is used by the server and the screens.
