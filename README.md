# Open Play Generator By draiyned 

A pickleball open-play court rotation manager. Pure HTML, CSS, and vanilla JavaScript —
no frameworks, no build step, no CDN, no dependencies of any kind.

## Files
- `index.html` — page shell
- `style.css` — all styling
- `app.js` — all app logic and rendering (plain JavaScript, no JSX/React/Babel)

## Run locally
Because there are no external scripts or fetch-based loading, this works either way:

**Option A — just open the file**
Double-click `index.html`, or drag it into a browser tab. It should work directly.

**Option B — serve it (recommended for consistency across browsers)**
```bash
cd path/to/this/folder
python3 -m http.server 8000
# then open http://localhost:8000 in your browser
```
or, with Node:
```bash
npx serve .
```

## Deploy to GitHub Pages
1. Push `index.html`, `style.css`, and `app.js` to a repo (keep them at the repo root, or in `/docs` if that's your configured Pages folder).
2. In the repo: **Settings → Pages → Source**, pick the branch/folder containing `index.html`.
3. This site will be live at `https://draiyned.github.io/openplay/`.

## Deploy to Vercel
1. Push the repo to GitHub (or drag-and-drop the folder into the Vercel dashboard).
2. In Vercel: **Add New Project → Import** the repo.
3. Framework preset: **Other** (static HTML/CSS/JS, no build command needed).
4. Deploy.

## Why this version instead of the React/Babel/Tailwind one
The earlier version loaded React, Babel Standalone, and Tailwind from CDNs at runtime.
That's convenient, but it has two failure modes this version removes entirely:
- It needs internet access to those CDNs, and can be blocked by browser content-blocking
  (ad blockers, Brave Shields, etc.) or restrictive networks.
- Babel Standalone loaded the app code via a background `fetch()`, which some browsers
  block when the page is opened directly as a `file://` URL.

This version has zero external requests and uses a plain `<script src="app.js">` tag,
so both of those failure modes are gone.

## Email log and device blocking (Google Sheet)
The gate records each visitor's email and a per-browser device ID in a Google Sheet that
only you can open, and refuses anyone you've marked as blocked.

1. Create a new Google Sheet. Open **Extensions → Apps Script**.
2. Replace the editor contents with `apps-script/Code.gs` from this repo and save.
3. **Deploy → New deployment → type: Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy and authorize.
4. Copy the web-app URL (ends in `/exec`) and paste it into `ACCESS_URL` in `index.html`.
5. Push to GitHub. Each sign-in now appears as a row in the **Access** sheet.

**Block / unblock:** change the **Status** cell to `blocked` or `allowed`. A visitor is refused if any
row matching their email *or* their device ID says `blocked`, so to unblock someone set every row
with their email and device ID back to `allowed`. Blocks apply at the next sign-in, not mid-session.

**Limits:** the device ID is a random value stored in the browser. Clearing site data, private mode,
or another browser/phone gets a new ID, so the email block is what holds those cases. Anyone can type
someone else's email. If you edit `Code.gs` later, create a **new version** under Manage deployments.

## Google sign-in (verified emails)
With a Google client ID set, visitors tap **Sign in with Google** and the script confirms the
sign-in with Google before logging the email, so nobody can type someone else's address.

1. Go to console.cloud.google.com, create a project, then **APIs & Services → OAuth consent screen**
   (External; app name and your email). Set the publishing status to **In production**.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Under
   **Authorized JavaScript origins** add your site's address only (for GitHub Pages: `https://draiyned.github.io`).
3. Copy the **Client ID** and paste it in two places: `GOOGLE_CLIENT_ID` in `index.html` and
   `GOOGLE_CLIENT_ID` at the top of `Code.gs` in Apps Script.
4. In Apps Script: **Deploy → Manage deployments → Edit → New version → Deploy** (approve the new permission).

Google sign-in does not work when the page is opened as a local file; use the real site address.

## Court timers
Every court shows a rental clock that starts when the session starts (or when a court is added) and
can be paused/resumed. The total across courts, in `HH:MM:SS` and court-hours, sits above the courts.
Time from a removed court stays in the total. Ending the session clears the timers.

## Admin page (/admin/)
`admin/index.html` lists everyone who signed in and lets you block or unblock them, so you never
need to open the sheet (it stays behind the scenes as the database).

- Set `ADMIN_KEY` in `Code.gs` (12+ characters, kept only in Apps Script), redeploy a new version,
  then open `https://<your-site>/admin/` and enter the key.
- **Block** puts that email and device on hold. **Unblock** clears every hold tied to that email or device.
- 8 wrong keys locks the admin API for 15 minutes.
- Site settings (`ACCESS_URL`, `GOOGLE_CLIENT_ID`) now live in `config.js` and are shared by the gate and the admin page.

## Live blocking and sign-in alerts
- While someone is inside, the page asks the script every 15 seconds (and when they return to the tab)
  whether they were put on hold. If so they are sent back to the sign-in screen. Offline or a server
  hiccup never kicks anyone out. Change the interval with `POLL_SECONDS` in `config.js`.
- Every sign-in (and every blocked attempt) emails the Google account that owns the script, or `NOTIFY_EMAIL`
  if set. At most 30 alerts per hour are sent, to protect Gmail's daily limit. Run `authorize_` once in
  the Apps Script editor to approve the email permission, then deploy a new version.

## Restore after closing a tab
Each tab keeps its own session (players, courts, matches, leaderboard, timers) and also saves a copy on the
device. A new tab lists the saved sessions of closed tabs (newest first, within 12 hours) with **Restore** or
**Discard** for each, so several groups in several tabs can be recovered separately. A session saved in the
last 30 seconds is flagged "may still be open in another tab". Court timers keep running while a tab is closed.

## Past sessions (saved results)
Ending a session saves the leaderboard and every match under **Past sessions** on this device (last 20),
with a CSV download. Undoing "End session" removes the saved copy again.

## Live view (QR code)
During a session, **Share live** → **Create QR code** gives players a link/QR to `live/`, showing
courts, the NEXT lineup, the leaderboard and recent results. Needs `ACCESS_URL` in `config.js` and the latest
`Code.gs` deployed as a new version. Only this device can update a link (secret token); links expire 6 hours
after the last update. The QR code is generated in `qr.js` with no outside service.

## Next pairs
The host's Waiting list and the QR page show the next matches as pairs (e.g. "NEXT: Ann & Bo vs Cy & Di", then
the following matches). They come from the same matchmaker as the courts, and a free court receives exactly the
previewed pairs as long as the waiting list hasn't changed. Later matches can still change.

The shared live view ranks players by wins (fewest losses breaks ties; equal records share a rank) and does not
show point differences or ratings. Match scores still appear under Recent results.
