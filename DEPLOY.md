# Deploy Xavion Fitness Studio to Cloudflare

**Result:** the gym app at **https://app.xavionfitness.in**, with its D1 database **`smartgym`**.

One Cloudflare Worker (`smartgym-api`) serves everything: `/api/*` runs the Python API and every
other address serves the web app. Cloudflare creates the `app` DNS record and the HTTPS certificate
by itself.

Run every command in **Terminal**, from the project folder (`xavionfitnessstudio-main`).

---

## 1. Before you start (once)

1. **The domain must be on Cloudflare.** In the Cloudflare dashboard, open the account that will
   host the app → **Websites** → `xavionfitness.in` must show **Active**. If it isn't there:
   **Add a domain** → `xavionfitness.in` → Free plan → change the two nameservers at your domain
   registrar to the ones Cloudflare shows → wait until it says **Active** (minutes to a few hours).
2. **Don't create an `app` DNS record yourself.** The deploy creates it. If an old `app` record
   exists under **DNS → Records**, delete it first.
3. **Install the tools** on this Mac:
   - **Node.js 22 LTS:** download the macOS installer from https://nodejs.org and run it.
   - **uv** (Python tooling):
     ```bash
     curl -LsSf https://astral.sh/uv/install.sh | sh
     ```
     Close Terminal and open it again so `uv` is found.
   - Check both work:
     ```bash
     node --version && uv --version
     ```

## 2. Sign in to the right Cloudflare account

This Mac is currently signed in to **nexverrtech@gmail.com**, which does **not** have
`xavionfitness.in` or the `smartgym` database. Sign out, then sign in with the account that owns
`xavionfitness.in`:

```bash
cd backend
npx wrangler logout
npx wrangler login
npx wrangler whoami
```

`whoami` must show the account that owns `xavionfitness.in`. If it lists several accounts, copy that
account's **Account ID** and use it for this Terminal session:

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account id>
```

## 3. The database `smartgym`

```bash
npx wrangler d1 list
```

- **`smartgym` is listed:** check that its id is the one in `backend/wrangler.jsonc`
  (`"database_id": "8b7fb068-42ea-4193-8c22-7e6844357d33"`). If it's different, put the listed id
  there.
- **Not listed:** create it, then copy the printed `database_id` into `backend/wrangler.jsonc`:
  ```bash
  npx wrangler d1 create smartgym --location apac
  ```

Create the tables (10 migrations; safe to run again later):

```bash
npx wrangler d1 migrations apply smartgym --remote
```

## 4. Secrets

Secrets live only on Cloudflare: never in the code or in Git. Create two random keys and store
them. Each command asks you to paste a value; paste the output of `openssl rand -base64 48` (run
it once for each key, so the two keys are different):

```bash
openssl rand -base64 48
npx wrangler secret put JWT_SECRET
openssl rand -base64 48
npx wrangler secret put AUTH_SECRET
```

> Keep `AUTH_SECRET` the same from now on: changing it later makes every password invalid.

A one-time token for creating the first admin (step 7). Run `openssl rand -hex 24`, **save the
output somewhere safe** (you'll paste it on the setup page), and store it:

```bash
openssl rand -hex 24
npx wrangler secret put SETUP_TOKEN
```

The first `secret put` may ask to create the Worker `smartgym-api`: answer **yes**.

## 5. Build the web app

```bash
cd ../frontend
npm ci
npm run build
```

Leave `VITE_API_URL` empty. If a `frontend/.env.local` file sets it, delete that line: the app
and the API share one address.

## 6. Deploy

First the small live-updates Worker (WebSockets; the main Worker connects to it, so it goes first),
then the app + API:

```bash
cd ../realtime
npx wrangler deploy
cd ../backend
uv sync
uv run pywrangler deploy
```

`xavion-realtime` has no web address of its own: it is reached only through the main Worker.
It uses a SQLite-backed Durable Object, which is included in the Workers Free plan.

The output ends with:

```
Deployed smartgym-api triggers
  app.xavionfitness.in (custom domain)
  schedule: 30 0 * * *
  schedule: * * * * *
```

Check it (the first call after a quiet spell can take 2–3 seconds):

```bash
curl https://app.xavionfitness.in/api/health
```

It answers `{"status":"ok",...}`. Then open **https://app.xavionfitness.in** in the browser.

> If your Mac says the address can't be found right after deploying, its DNS cache is stale:
> `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, or try your phone on mobile data.

### 6b. City names for signed-in devices (once, free)

The Security page shows each device's GPS location and the city it signed in from. For the city,
turn on Cloudflare's visitor location headers: **Cloudflare dashboard → xavionfitness.in → Rules →
Settings → Managed Transforms → "Add visitor location headers" → On**. (Without it you still get
the GPS position and the country.)

## 7. Create the admin account

1. Open **https://app.xavionfitness.in/setup**.
2. Paste the setup token from step 4, then your name, email and a strong password.
3. You land on the Dashboard. Now remove the setup token so nobody else can use the page:
   ```bash
   npx wrangler secret delete SETUP_TOKEN
   ```

## 8. Set up the gym (in the app)

- **Settings → Gym:** name (*Xavion Fitness Studio*), address, phone, email.
- **Settings → Payments:** UPI ID and payee name; **Receipt & GST:** GSTIN, SAC, GST rate,
  **Signed by** (your name on the digital signature), terms and conditions.
- **Settings → Team:** front-desk staff accounts.
- **Membership Plans**, **Trainers**, then **Members**.

## 9. Automatic emails (optional, recommended)

Receipts, welcome, renewal / expiry reminders, failed payments and refunds go out by email
automatically once these two secrets are set. WhatsApp is through the **Send on WhatsApp**
buttons in the app, so no setup is needed for it.

1. Sign up at **https://resend.com** → **Domains → Add domain** → `xavionfitness.in`.
2. Resend shows a few DNS records. Add each one in Cloudflare → `xavionfitness.in` → **DNS →
   Records** (type, name and value exactly as shown; set **Proxy status: DNS only**). Click
   **Verify** in Resend; it turns green within minutes.
3. In Resend → **API Keys → Create API key** (sending access), then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put EMAIL_FROM
   ```
   For `EMAIL_FROM` enter an address on the verified domain, e.g. `updates@xavionfitness.in`.
   Secrets take effect at once (no redeploy).

Resend's free plan sends 100 emails a day / 3,000 a month.

## 10. Automatic deploys from GitHub (optional)

Every push to `main` then builds, tests, migrates and deploys
(`.github/workflows/deploy-backend.yml`).

1. Cloudflare → **My Profile → API Tokens → Create Token** → template **Edit Cloudflare
   Workers** → add the permission **Account · D1 · Edit** → limit it to your account and the zone
   `xavionfitness.in` → **Create** and copy the token.
2. GitHub → the repository → **Settings → Secrets and variables → Actions → New repository
   secret**:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = the account id (from `npx wrangler whoami`)
3. Push to `main`, or run it by hand: **Actions → Deploy → Run workflow**.

## Updating the app later

Push to `main` (step 10), or from this Mac:

```bash
cd frontend && npm run build && cd ../backend
npx wrangler d1 migrations apply smartgym --remote
uv run pywrangler deploy
```

## If something goes wrong

| What you see | What to do |
|---|---|
| `Couldn't find a D1 DB with name 'smartgym'` | Wrong Cloudflare account (step 2), or the database doesn't exist yet (step 3). |
| Deploy fails on the custom domain / "hostname already has a DNS record" | Delete the existing `app` record in DNS → Records, then deploy again. |
| `xavionfitness.in` isn't in the account | Add the domain and switch the nameservers (step 1). |
| Error 1016 or "can't be reached" | The Worker or its custom domain was removed: deploy again (step 6). |
| The app shows "The server is not configured yet" | `JWT_SECRET` / `AUTH_SECRET` missing or too short: step 4. |
| `/setup` says "Setup is not available" | An admin already exists (sign in at `/login`), or `SETUP_TOKEN` isn't set. |
| A page shows an error after an update | Migrations not applied: `npx wrangler d1 migrations apply smartgym --remote`. |

## Old resources

The **nexverrtech@gmail.com** account still has an unused database `smartgym-db`
(`773a9877-…`). Once the new site works, you can delete it in that account under
**Workers & Pages → D1**. It isn't used by this project any more.
