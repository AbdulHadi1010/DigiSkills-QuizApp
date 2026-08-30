# DigiQuiz — Local Development Bundle

Run the **real three-tier app** on one machine with one command, and open it from
your phone over WiFi.

This is the same code as the AWS build: the same `app-server.js`, the same
`web-server.js`, the same `admin.html`, the same student UI, the same schema and
seed data. Nothing was rewritten to make it run locally — the differences are
listed exhaustively in [Dev vs AWS](#dev-vs-aws) and every one of them is a
config change, not a code fork.

---

## Quick start (Windows)

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

That is the whole thing. It picks the best available path, starts both tiers,
prints the URL for your phone and a QR code of it.

> **If PowerShell refuses to run the script** — "running scripts is disabled on
> this system" — you have two options. Either allow scripts for your own user
> once (no Administrator needed):
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
>
> or bypass it for this single run without changing any setting:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\start.ps1
> ```

Useful switches:

| Switch | Effect |
|---|---|
| `.\start.ps1 -Port 8081` | use a different port (if 8080 is taken) |
| `.\start.ps1 -Mode node` | force Path B even if Docker is running |
| `.\start.ps1 -Mode docker` | force Path A |
| `.\start.ps1 -OpenFirewall` | add the inbound firewall rule (needs an **Administrator** PowerShell) |
| `.\start.ps1 -NoQr` | skip the QR code |

### macOS / Linux

```bash
./start.sh
```

Same flags, `--port 8081`, `--node`, `--docker`, `--no-qr`.

---

## Sign in with

These accounts are seeded into the database and **work immediately**. The hashes
in the SQL files are real bcrypt digests (cost 10) of these exact passwords —
not placeholders.

| Username | Password | Role | What it unlocks |
|---|---|---|---|
| `student_demo` | `Passw0rd!` | student | take quizzes, see your attempts and the leaderboard |
| `ali` | `Passw0rd!` | student | a second student, useful for the leaderboard |
| `admin` | `Admin123!` | **admin** | everything above **plus** the `/admin` console |

You can also register a new account from the UI — self-registration always
creates a `student`, never an admin.

> These passwords are published here on purpose: this is a local development
> bundle. Delete or re-hash those three rows before the app ever faces real
> users. `wp5-secrets-and-iam.md` covers how credentials are handled for real.

---

## The two paths

`start.ps1` / `start.sh` choose automatically. You can also run either directly.

### Path A — Docker (preferred)

Closest to the AWS topology: three containers, real MySQL 8, real network
separation between the tiers.

```powershell
docker compose up --build
```

Then open <http://localhost:8080>.

| Container | Stands in for | Port |
|---|---|---|
| `digiquiz-db` — `mysql:8.0` | RDS MySQL Multi-AZ | not published |
| `digiquiz-app` — Node | App EC2 ASG (private subnets) | not published |
| `digiquiz-web` — Node | Web EC2 ASG behind the ALB | `0.0.0.0:8080` |

`sql/digiquiz.sql` is mounted into `/docker-entrypoint-initdb.d`, so MySQL loads
the schema and seed data itself the first time the volume is created.

**The tier separation is real, not decorative.** There are two Docker networks:

- `private` (marked `internal: true`) — only `db` and `app` are attached
- `internal` — only `web` and `app` are attached

The `web` container is not on the `private` network at all, so a connection from
the web tier to `db:3306` fails at the network layer. That is the same guarantee
the RDS security group gives on AWS, enforced the same way: by topology, not by
the application promising to behave.

Stop and clean up:

```powershell
docker compose down          # stop
docker compose down -v       # stop and delete the database volume
```

**Requirements:** Docker Desktop installed and running. First run pulls the MySQL
image and builds two Node images — a few minutes. After that it is seconds.

### Path B — Node + SQLite (no Docker, no MySQL)

For a laptop with nothing installed but Node.

```powershell
npm run dev
```

> **`node_modules/` is already in this folder**, so you can skip `npm install`
> entirely and run offline. All three dependencies are pure JavaScript with no
> compiled binaries, so the pre-installed tree works on any OS. Run
> `npm install` only if you want to refresh it.

| What | Where |
|---|---|
| app tier | `127.0.0.1:4000` |
| web tier | `0.0.0.0:8080` |
| database | `data/digiquiz.sqlite`, created and seeded on first run |

**Requirements — read this if `npm run dev` complains:**

- **Node 22.5.0 or newer.** This is the floor because Path B uses `node:sqlite`,
  the SQLite engine built into Node, which first shipped in 22.5.0. Check with
  `node --version`. Get it from <https://nodejs.org> — the Windows `.msi`
  installer, all defaults.
- **Dependencies: exactly three packages — `express`, `bcryptjs`,
  `jsonwebtoken`** (81 including their transitive dependencies, 3.8 MB). All are
  pure JavaScript: **zero native compilation**, so you do **not** need Python,
  `node-gyp`, or Visual Studio Build Tools. They are already installed in
  `node_modules/`, so Path B needs no internet connection at all. `npm install`
  is available if you want to refresh them.
- **No `mysql2`.** Path B never talks to MySQL, so the driver is not installed.
- **`better-sqlite3` is a fallback only.** If you are stuck below Node 22.5 and
  cannot upgrade, `npm install better-sqlite3` also works — `app-tier/db.js`
  detects it automatically. But it is a **native module**: on Windows it needs
  the Visual Studio C++ Build Tools, which is a multi-gigabyte install. Upgrading
  Node is much easier. Use Docker if neither appeals.

Reset the database to its seeded state:

```powershell
npm run reset-db
```

---

## Opening it on your phone

1. Make sure the phone and the computer are on **the same WiFi network**.
2. Run `.\start.ps1`.
3. Read the banner:

   ```
     Open on your phone:  http://192.168.1.42:8080
     (phone and computer must be on the same WiFi)
   ```

4. Point the phone camera at the QR code, or type the URL into the phone browser.

The address is detected with `Get-NetIPAddress` on Windows, which knows the
difference between your WiFi adapter and the Hyper-V, WSL and Docker Desktop
virtual adapters that also have IP addresses and that a phone can never reach.
If it still picks wrong, the banner lists the other addresses on the machine —
try those.

Both tiers bind `0.0.0.0`, not `127.0.0.1`. Binding to localhost is the classic
reason a dev server works on the laptop and times out on every other device.

### Troubleshooting: the phone cannot open the page

**1. The phone is on mobile data, not WiFi.**

This is the most common cause and the easiest to miss — phones silently fall back
to cellular when the WiFi has no internet, and `192.168.x.x` means nothing on the
mobile network, so the browser just spins and times out.

- iPhone: Settings → Wi-Fi. The network must show a blue tick. Also check
  Settings → Mobile Data → **Wi-Fi Assist** and turn it **off** — that feature
  exists specifically to switch you to cellular behind your back.
- Android: Settings → Network & internet → Internet. Turn **Adaptive
  connectivity** / **Switch to mobile data automatically** off.
- Quickest test: turn mobile data off entirely, then reload the page.
- Confirm the phone is on the right subnet: if the computer is `192.168.1.42`,
  the phone's own IP should start `192.168.1.` too.

**2. The host firewall is blocking port 8080.**

The server is running and listening; the operating system is refusing the
incoming connection. `start.ps1` tests for this and warns you.

*Windows* — in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DigiQuiz dev 8080" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private
```

or just re-run the script elevated: `.\start.ps1 -OpenFirewall`.

To remove it afterwards:

```powershell
Remove-NetFirewallRule -DisplayName "DigiQuiz dev 8080"
```

Also check your **network profile**. Windows blocks nearly all inbound traffic on
networks marked *Public*, and it marks new WiFi networks Public by default:

```powershell
Get-NetConnectionProfile
```

If `NetworkCategory` is `Public`, change it (Administrator):

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

Use the exact `InterfaceAlias` that `Get-NetConnectionProfile` printed. Only do
this on a network you trust — your home WiFi, not an airport.

If Windows pops up a "Windows Defender Firewall has blocked some features of this
app" dialog when the server starts, tick **Private networks** and click **Allow
access**. If you dismissed it earlier, the rule above does the same job.

*macOS* — System Settings → Network → Firewall. If it is on, click **Options** and
allow incoming connections for `node` (Path B) or `Docker` (Path A). From the
terminal:

```bash
sudo /usr/libexec/ApplicationFirewall/socketutil --add $(which node)
sudo /usr/libexec/ApplicationFirewall/socketutil --unblockapp $(which node)
```

*Linux* — `sudo ufw allow 8080/tcp`, or
`sudo firewall-cmd --add-port=8080/tcp`.

**3. The WiFi has client isolation turned on.**

Guest networks, hotel WiFi, university WiFi and most corporate networks enable
*client isolation* (also called AP isolation, station isolation, or "guest mode").
Every device gets internet access but devices cannot talk to **each other** —
by design, so that guests cannot see each others' laptops.

You cannot fix this from your machine. The symptom is distinctive: the phone has
working internet, the laptop has working internet, the firewall is open, the IP
address is right, and the connection still times out. `ping 192.168.1.42` from a
phone network tool will also fail.

What to do instead:

- **Use a phone hotspot.** Turn on the phone's hotspot, connect the *laptop* to
  it, then re-run `.\start.ps1` — it will detect the new address. The phone and
  laptop are now on a tiny private network with no isolation. This works even
  with no internet at all, and it is the most reliable workaround.
- **Use your home WiFi** rather than the guest or corporate SSID.
- **Check the router**, if it is yours: the setting is usually under the guest
  network options, named "AP isolation", "client isolation", or "allow guests to
  see each other".
- **Give up on the phone and demo from the laptop browser** at
  <http://localhost:8080>, which never touches the network.

**4. Something else is already using port 8080.**

```powershell
.\start.ps1 -Port 8081
```

On Windows, find the culprit with `netstat -ano | findstr :8080` and look the PID
up in Task Manager.

---

## Dev vs AWS

Everything in this table is a deliberate, documented deviation. Everything *not*
in this table behaves exactly as it does on AWS.

| # | Dev bundle | AWS build | Why the difference is safe |
|---|---|---|---|
| 1 | **Database engine (Path B only):** SQLite in `data/digiquiz.sqlite`, via a mysql2-shaped adapter in `app-tier/db.js` | RDS MySQL 8, Multi-AZ, encrypted at rest, automated backups | The adapter sits *below* the SQL. Not one line of route logic changes — `app-server.js` calls `pool.execute` / `pool.getConnection` / `beginTransaction` identically either way. Path A uses real MySQL, so the MySQL path is exercised too. |
| 2 | **Port:** web tier on 8080 | ALB on 443 (HTTPS via ACM), HTTP→HTTPS 301 redirect, web tier on 80 | Ports below 1024 need Administrator/root on every OS. 8080 keeps the whole thing a non-privileged process. |
| 3 | **Secrets:** `.env` file, or a random `JWT_SECRET` generated per run | AWS Secrets Manager + a customer-managed KMS key, fetched at boot by an IAM role scoped to exactly two secrets. The web tier has no such role | See `wp5-secrets-and-iam.md`. The *application* reads `process.env` in both cases — only the thing that populates the environment changes. |
| 4 | **Static UI:** served by the web tier from `web-tier/public/` when `SERVE_STATIC_DIR` is set | Private S3 bucket behind CloudFront with Origin Access Control; the web tier serves exactly one page, `/admin` | Gives the dev stack a single origin, so there is no CORS hop and the phone needs only one URL. Unset the variable and the web tier behaves exactly as it does in production. The static middleware is mounted **last**, after every explicit route, so it can never shadow `/api/*`, `/admin` or `/health`. |
| 5 | **API base URL:** `const API_BASE = '';` in `web-tier/public/app.js` (same origin) | the ALB origin, e.g. `https://api.digiquiz.example.com` | That constant exists to be configured; the file documents it as the one thing to set before uploading to S3. |
| 6 | **Scale:** one app process, one web process | Two Auto Scaling groups, min 2 across two AZs, behind load balancers | Auth is stateless JWT precisely so instance count is irrelevant. Running one of each is a scale choice, not an architecture change. |
| 7 | **Network isolation:** Docker networks (Path A); a single host (Path B) | VPC with public/app/db subnet tiers, a NAT Gateway, and the SG chain Internet → ALB-SG → Web-SG → App-SG → RDS-SG | Path A reproduces the important half: the `web` container is not attached to the `private` network, so it cannot reach the database even in principle. Path B relies on the structural guarantee instead — see below. |

### What is *not* relaxed

These are the properties the project exists to demonstrate, and they hold
identically in both dev paths and on AWS:

- **`options.is_correct` never reaches the browser.** The quiz-read query is
  `SELECT id, question_id, label, option_text` — the column is not in the SELECT
  list, so it cannot be in the result set, so it cannot be in the JSON. Verified
  on every endpoint by `npm run verify`.
- **Grading happens in the app tier.** The web tier receives `{score, total}` and
  forwards it. It never sees an answer key, so it could not grade if it wanted to.
- **The web tier never touches the database.** It has no driver in its
  `package.json` and no SQL in its source. `web-tier/Dockerfile` **fails the
  build** if a database driver ever appears in its dependency tree.
- **The web tier holds no JWT signing key.** It has no `jsonwebtoken` dependency.
  It decodes the `/admin` token unverified for a redirect decision only; the app
  tier verifies the signature and re-checks the admin role on every write.
- **`/admin` is server-rendered by the web tier**, not shipped as a static file,
  and all quiz-creation writes still flow Web → App → database in a transaction.
- **Passwords are bcrypt hashed.** Self-registration always creates a `student`;
  a `role` field in the request body is ignored.

---

## Verifying it yourself

```powershell
npm run verify      # boots both tiers on scratch ports, drives the whole flow
npm run test:qr     # self-test for the vendored QR encoder
```

`npm run verify` runs 71 checks including the answer-key leak test, the auth
negatives (tampered token, `alg:none`, SQL injection), the IDOR checks and the
admin transaction rollback. It uses its own ports (8999/4999) and a throwaway
database, so it is safe to run while the stack is up.

---

## What is in this folder

```
digiquiz-dev/
├── DEV-README.md              this file
├── start.ps1                  Windows launcher (primary entry point)
├── start.sh                   macOS / Linux launcher
├── docker-compose.yml         Path A — three services
├── package.json               Path B dependencies + npm scripts
├── .env.example               copy to .env to pin the ports and JWT secret
│
├── sql/
│   ├── digiquiz.sql           MySQL schema + seed (Path A, and the AWS build)
│   └── digiquiz.sqlite.sql    SQLite mirror (Path B) — same rows, same IDs
│
├── app-tier/                  PRIVATE tier — all business logic, the only tier
│   ├── app-server.js            that runs SQL
│   ├── db.js                  mysql2 | node:sqlite adapter
│   ├── package.json           includes mysql2
│   └── Dockerfile
│
├── web-tier/                  PUBLIC tier — validates, forwards, renders /admin
│   ├── web-server.js
│   ├── admin.html             server-side template for the admin console
│   ├── public/                DEV ONLY — stands in for S3 + CloudFront
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── package.json           express only — no DB driver, no JWT library
│   └── Dockerfile             fails the build if a DB driver appears
│
├── tools/                     all zero-dependency, all offline
│   ├── dev.js                 Path B supervisor — starts both tiers
│   ├── banner.js              the "open on your phone" banner
│   ├── lanip.js               LAN address detection and ranking
│   ├── qr.js                  vendored QR encoder (ISO/IEC 18004)
│   ├── qr.test.js             QR self-test
│   └── verify-dev.js          end-to-end verification harness
│
└── data/                      Path B SQLite file lands here (git-ignored)
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Path B — start both tiers against SQLite |
| `npm run dev:docker` | Path A — `docker compose up --build` |
| `npm run verify` | end-to-end verification (71 checks) |
| `npm run test:qr` | QR encoder self-test (52 checks) |
| `npm run syntax-check` | `node --check` on every JS file |
| `npm run ip` | show detected LAN addresses and how they were ranked |
| `npm run qr -- "http://..."` | render an arbitrary QR code |
| `npm run banner` | print the phone banner without starting anything |
| `npm run reset-db` | delete `data/` so the next run re-seeds |
| `npm run clean:docker` | `docker compose down -v` |
