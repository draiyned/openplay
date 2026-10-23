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
