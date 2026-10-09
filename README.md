# Nexafin Backend (SecurePay Lab)

A full-stack payment operations platform with Express.js backend, React + Vite frontend (Operational Dashboard), PostgreSQL/Neon support, KYC management, settlement tracking, and payment simulation.

## Table of Contents

- [Overview](#overview)
- [Old Backend vs New Backend (SecurePay Lab)](#old-backend-vs-new-backend-securepay-lab)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Local Installation](#local-installation)
- [Environment Setup](#environment-setup)
- [Database Setup (Neon/Postgres)](#database-setup-neonpostgres)
- [Running the Application](#running-the-application)
- [Operational Dashboard - Full Workflow](#operational-dashboard---full-workflow)
- [Payment Simulator](#payment-simulator)
- [Testing](#testing)
- [API Endpoints Overview](#api-endpoints-overview)
- [Security Center & Fraud Lab](#security-center--fraud-lab)
- [Git Workflow - Commit to GitHub](#git-workflow---commit-to-github)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Overview

This project is a learning-focused backend (nexafin-backend-learning) that evolved from a basic payment backend to **SecurePay Lab** - an operations console with enhanced reliability, security, observability, settlement tracking, and KYC journey management. The app now supports both **Neon/Postgres** (hosted) and local development with proper sandbox capabilities.

## Old Backend vs New Backend (SecurePay Lab)

| Feature | Old Backend | New Backend (SecurePay Lab) |
|---|---|---|
| Database | MySQL (config via DB_*) | **Postgres/Neon** via `DATABASE_URL` with automatic dialect detection + TLS |
| Payment Flow | Basic Pine Labs integration | Enhanced with idempotency, state machine, event engine, and signed webhooks |
| Security | Basic auth | BOLA/IDOR fixes, idempotency keys, signed webhooks (HMAC-SHA256), fail-closed validation |
| KYC | Basic KYC routes | **Full 10-step KYC journey** with blockers, completion %, admin review UI, document status tracking |
| Settlement | Not present | **Settlement tracking** (UNSETTLED/SETTLED/ON_HOLD), settlement engine, admin ops dashboard |
| Observability | Minimal logging | Event bus, payment events, audit logs, SSE-based live dashboard updates |
| Testing | Basic tests | Expanded sandbox E2E (22 checks: UPI, NetBanking, Card) + unit tests (64) |
| Operations | Limited UI | **Operational Dashboard** with live KPIs, settlement card, KYC review, Payment Simulator |
| Sandbox | Limited | Pine Labs-compatible sandbox at `/sandbox/pinelabs` (deterministic outcomes for demos) |
| Idempotency | Partial | Enforced `Idempotency-Key` with hash validation, replay, and UNKNOWN state handling |

## Repository Structure

```
.
├── index.js                 # Backend entry point
├── src/
│   ├── app.js               # Express app + route mounting
│   ├── config/              # DB config, sync, auto-detect dialect
│   ├── controllers/         # API controllers (auth, payments, admin, ops)
│   ├── middlewares/         # Auth, rate limiting, idempotency
│   ├── models/               # Sequelize models (Postgres-compatible)
│   ├── routes/               # Route definitions
│   ├── securepay/           # State machine, event engine, ledger, kycJourney, settlement
│   ├── sandbox/             # Payment sandbox (Pine Labs compatible)
│   ├── Services/            # External provider integrations
│   └── utils/               # Helpers (idempotency, pagination, ApiResponse, etc.)
├── client/                  # React + Vite Operational Dashboard
│   ├── src/
│   │   ├── pages/           # Dashboard, KYC, Simulator, Login, etc.
│   │   ├── components/      # Layout, UI components
│   │   ├── lib/             # API helpers, live stream (SSE)
│   │   └── contexts/        # Auth context
│   └── dist/                # Built frontend (if served)
├── scripts/                 # Setup, seeding, sandbox E2E
├── tests/                   # Unit tests (node:test)
└── .env.example             # Environment template
```

## Tech Stack

**Backend:** Node.js (ESM), Express 5, Sequelize 6, pg@^8, pg-hstore@^2  
**Frontend:** React 19, Vite 7, Tailwind CSS 4, React Router DOM 7  
**Database:** PostgreSQL (Neon hosted recommended; local Postgres works)  
**Auth:** JWT  
**Real-time:** Server-Sent Events (SSE) via event bus/engine  
**Testing:** Node.js built-in test runner (`node --test`), custom sandbox E2E

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ (v20+ recommended)
- [npm](https://www.npmjs.com/) v9+
- [Git](https://git-scm.com/)
- PostgreSQL instance (local) OR [Neon](https://neon.tech/) account for hosted DB
- GitHub account with repo access

## Local Installation

### 1. Clone the Repository

```bash
git clone https://github.com/devtailor172004/nexafin-backend-learning.git
cd nexafin-backend-learning
```

### 2. Install Backend Dependencies

```bash
npm install
```

### 3. Install Frontend Dependencies

```bash
cd client
npm install
cd ..
```

## Environment Setup

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Update `.env` with your values. Key variables:

| Key | Required | Description |
|---|---|---|
| `PORT` | Yes | Backend port (default: 3000) |
| `NODE_ENV` | Yes | `development`/`production` |
| `DATABASE_URL` | **Recommended** | Neon/Postgres connection string (e.g., `postgresql://...@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`) |
| `JWT_SECRET` | **Critical** | Long random string for token signing (min 32 chars) |
| `CORS_ORIGINS` | Yes | Comma-separated origins (e.g., `http://localhost:5173,http://localhost:3000`) |
| `PAYMENT_SANDBOX_ENABLED` | Yes | Set to `true` for local/demo testing |
| `SANDBOX_WEBHOOK_DELAY_MS` | No | Webhook delay (default 600ms) |
| `PINE_LABS_CLIENT_SECRET` | Yes | Used for sandbox webhook HMAC signing (can use any string for sandbox) |
| `VERIFICATION_*` | No | KYC vendor config (leave blank for demo) |
| `DIGILOCKER_*` | No | DigiLocker config (optional) |

**For sandbox/demo mode:** You can use dummy values for provider keys. The app uses built-in sandbox when `PAYMENT_SANDBOX_ENABLED=true`.

## Database Setup (Neon/Postgres)

The app auto-detects dialect from `DATABASE_URL`. If using Neon:

1. Create a [Neon](https://neon.tech/) project → get your connection string (with `sslmode=require`)
2. Put it in `.env` as `DATABASE_URL`
3. Schema auto-syncs on startup (non-production). For first run, tables are created automatically.

**Manual setup (optional):**

```bash
npm run db:setup  # Setup/prepare DB
npm run db:seed   # Seed initial data
```

## Running the Application

### Development Mode (Recommended)

**Terminal 1 - Backend:**

```bash
npm run dev
# or: node --env-file=.env --watch index.js
```

Backend runs at: `http://localhost:3000`

**Terminal 2 - Frontend (Operational Dashboard):**

```bash
cd client
npm run dev
```

Frontend runs at: `http://localhost:5173`  
API proxy is configured (`/api` → `http://localhost:3000`), so no extra CORS setup needed.

### Production Build

**Frontend:**

```bash
cd client
npm run build
```

Built files go to `client/dist/`. You can serve them with a static server or the backend can serve them in production.

**Backend:**

```bash
npm start
```

## Operational Dashboard - Full Workflow

The Operational Dashboard is the admin console for managing the entire platform.

### Access

1. Open `http://localhost:5173`
2. Login with the seeded admin:
   - **Email:** `SEED_ADMIN_EMAIL` from `.env` (default `admin@securepay.local`)
   - **Password:** `SEED_ADMIN_PASSWORD` from `.env`

> **Important:** `Admin@12345` is only the *fallback* used when `SEED_ADMIN_PASSWORD` is
> unset. If your `.env` defines `SEED_ADMIN_PASSWORD`, that value is what
> `npm run db:seed` hashed into the database, so it is the password you must type.
> The password is applied at seed time — editing `.env` afterwards does not change an
> existing account. Locked out after repeated attempts? Run `npm run auth:unlock`.

### Dashboard Overview

The main Dashboard (`/`) shows:
- **Live KPIs:** Total orders, payments, amounts, success rates (auto-refreshes via SSE on payment events)
- **Settlement Card:** Settlement summary (UNSETTLED/SETTLED/ON_HOLD) with refresh
- **Recent Activity:** Latest orders/payments/events

### KYC Management (`/kyc`)

Full workflow for KYC verification:

1. View all users with KYC status
2. Click on a user to see **10-step KYC journey**:
   - Business details, Signing authority+PAN, PAN, Aadhaar/DigiLocker, Address, Directors, Documents, Bank, Video KYC, Admin review
3. See **completion %**, **verified** flag, **blockers**, and **missing** items
4. Review individual documents: **Verify** or **Reject** each document
5. Track real-time journey state

### Settlement Operations

- View settlement summary and breakdown by status
- Identify unsettled/held payments
- Track settlement references and timestamps
- Refresh live data

### Payment Simulator (`/simulator`) - Admin-Only Demo Tool

The Simulator creates **real end-to-end transactions** using merchant APIs (no mock UI-only flow). It bridges merchant APIs → provider → webhook → operations.

**How to use:**

1. Go to `http://localhost:5173/simulator` (sidebar: "Payment Simulator")
2. Configure test parameters (amount, method: UPI/NetBanking/Card, demo values)
3. Click **Generate Token** → gets provider token
4. Click **Create Order** → creates order with `Idempotency-Key` (auto-generated)
5. Initiate Payment (UPI/NetBanking/Card) → calls merchant payment API
6. The system waits for **signed webhook** from sandbox (or provider)
7. View full **Flow Trace + Timeline** showing each step and final status (SUCCESS/FAILED/PENDING)

**Sandbox outcomes (deterministic):**
- Amount ending `.13` → FAILED
- Notes containing `FAIL` → FAILED  
- Card ending `0002` → FAILED  
- Otherwise → PROCESSED (success)

Webhook is HMAC-SHA256 signed using `PINE_LABS_CLIENT_SECRET` and has configurable delay.

## Payment Simulator

See [Operational Dashboard - Payment Simulator](#payment-simulator) above. The Simulator exercises real code paths:
- `POST /api/payment/nxpay/token`
- `POST /api/payment/nxpay/order` (with Idempotency-Key)
- `POST /api/payment/nxpay/order/:uuid/upi/payments`
- `POST /api/payment/nxpay/order/:uuid/netbanking/payments`
- `POST /api/payment/nxpay/order/:uuid/payments` (card)

All go through controllers → middlewares → provider (sandbox) → webhook handling → state updates.

## Testing

### Unit Tests

```bash
node --test --test-force-exit tests/*.test.js
```

**Result:** 64/64 PASS

### Sandbox E2E Tests

With backend running (or in appropriate mode), run:

```bash
npm run test:e2e:sandbox
```

**Result:** 22/22 PASS (covers UPI, NetBanking, Card flows + webhooks)

### Client Build Test

```bash
cd client
npm run build
```

Should complete with no errors (Vite transforms all pages including Simulator).

## API Endpoints Overview

| Base | Description |
|---|---|
| `/api/auth/*` | Authentication (login/register) |
| `/api/payment/*` | Merchant payment APIs (token, order, payments) |
| `/api/admin/kyc/*` | Admin KYC journey & document review |
| `/api/securepay/settlements/*` | Settlement endpoints (ops) |
| `/api/securepay/ops/*` | Operational data |
| `/sandbox/pinelabs/*` | Payment sandbox (only if enabled) |

Full route details in `src/routes/`.

## Git Workflow - Commit to GitHub

### Check Status

```bash
git status
git diff --stat
```

### Stage Changes

**Stage all relevant changes (exclude node_modules, .env):**

```bash
git add .
```

Or selectively:

```bash
git add src/ client/ scripts/ tests/ package.json README.md .env.example
```

### Commit

```bash
git commit -m "feat: your descriptive message here"
```

Or with conventional commits:

```bash
git commit -m "feat: add settlement tracking and payment simulator

- Add settlement model/engine/endpoints and dashboard UI
- Implement KYC 10-step journey with admin review
- Add Payment Simulator to operational dashboard
- Migrate to Postgres/Neon with dialect-aware sync
- Expand sandbox E2E to 22 checks"
```

### Push to GitHub

```bash
git push origin main
```

If you need to force push after amending (use with caution):

```bash
git push --force-with-lease origin main
```

### Create Branch (recommended for features)

```bash
git checkout -b feature/your-feature-name
# make changes, commit, push
git push -u origin feature/your-feature-name
# then open PR on GitHub
```

## Security Center & Fraud Lab

SecurePay Lab includes a defensive security layer built on top of the existing payment, idempotency, webhook and audit modules. It is an **educational, sandbox-only** implementation: every financial operation it exercises is simulated against synthetic data, and the Fraud Lab refuses to run when `NODE_ENV=production`.

### Reused, not duplicated

The security features extend what already existed rather than replacing it:

| Concern | Module |
| --- | --- |
| Payment state machine | `src/securepay/stateMachine.js` |
| Append-only payment timeline + SSE | `src/securepay/eventEngine.js`, `eventBus.js` |
| Webhook deduplication | `src/securepay/webhookLedger.js`, `models/ProviderWebhookEvent.js` |
| Idempotency | `src/utils/idempotency.js`, `models/IdempotencyKey.js` |
| Audit logging | `src/securepay/auditLog.js`, `models/AuditLog.js` |
| Reconciliation / settlement | `src/securepay/reconciliation.js`, `settlement.js` |

### What was added

| Capability | Module |
| --- | --- |
| Deterministic, explainable risk engine (11 rules, configurable thresholds) | `src/securepay/fraudEngine.js`, `src/config/fraudConfig.js` |
| Fraud orchestration: scoring, holds, freezes, incidents, admin review | `src/securepay/fraudService.js` |
| Double-entry ledger (integer minor units, immutable entries, row-locked posting, compensating reversals, invariant checks) | `src/securepay/ledger.js`, `models/LedgerAccount.js`, `models/LedgerEntry.js` |
| Tamper-evident hash-chained audit trail + fail-closed critical writes | `src/securepay/auditChain.js`, `src/securepay/auditLog.js` |
| Tenant isolation / BOLA guard | `src/securepay/tenant.js` |
| Auth hardening (generic login errors, hashed single-use OTPs, bounded lockout, session revocation on password reset) | `src/securepay/authHardening.js`, `controllers/Auth/auth.controller.js`, `middlewares/authMiddleware.js` |
| Namespaced security events on the existing SSE bus | `src/securepay/securityEvents.js` |
| Fraud Lab scenarios A–I | `src/securepay/fraudLab.js` |
| Security Center API (admin-only) | `controllers/SecurePay/security.controller.js`, `routes/SecurePay/security.route.js` |
| Security Center + Fraud Lab UI | `client/src/pages/SecurityCenter.jsx`, `client/src/pages/FraudLab.jsx` |

New models: `RiskEvent`, `AccountFreeze`, `SecurityIncident`, `LedgerAccount`, `LedgerEntry`. The `AuditLog` model gained `outcome`, `reason`, `source`, `correlationId`, `requestId` and the chain columns `sequence` / `prevHash` / `hash`.

### Risk decisions

Every attempt is scored 0–100 and receives one of `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` plus a decision:

- `ALLOW` — proceed.
- `STEP_UP` — proceed only after additional verification.
- `HOLD` — do not move money; an administrator must review.
- `BLOCK` — refuse outright.

By default a `HOLD` or `BLOCK` also freezes the account's money-moving capability until an administrator releases it with a documented reason. Change this with `FRAUD_FREEZE_ON` (e.g. `FRAUD_FREEZE_ON=BLOCK`).

### Security environment variables

All optional; defaults are safe for local sandbox use.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FRAUD_LAB_ENABLED` | enabled | Set `false` to disable scenario execution |
| `FRAUD_FREEZE_ON` | `HOLD,BLOCK` | Decisions that freeze the account |
| `FRAUD_VELOCITY_COUNT` | `5` | Attempts in the velocity window that trip the velocity rule |
| `FRAUD_VELOCITY_WINDOW_MINUTES` | `10` | Velocity window |
| `FRAUD_HIGH_AMOUNT_MINOR` | `500000` | High-value threshold in paise |
| `FRAUD_BENEFICIARY_BURST_COUNT` | `3` | Beneficiaries added in the burst window |
| `FRAUD_STEP_UP_SCORE` / `FRAUD_HOLD_SCORE` / `FRAUD_BLOCK_SCORE` | `30` / `50` / `70` | Decision cut-offs |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Failed logins before a temporary lockout |
| `AUTH_LOCKOUT_MINUTES` | `15` | Lockout duration |

> The Fraud Lab refuses to run in production regardless of these values.

### Running the security demo locally

```bash
# 1. Backend
cd /path/to/nexafin-backend-learning
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, PINE_LABS_CLIENT_SECRET
npm run db:setup              # create the schema (add --seed for the admin user)
npm run dev                   # http://localhost:3000

# 2. Frontend (second terminal)
cd client
npm install
npm run dev                   # http://localhost:5173
```

Log in as the seeded admin, then open **Security → Security Center** and **Security → Fraud Lab** in the sidebar.

### Security Center screens

| Screen | Route | Backend routes |
| --- | --- | --- |
| Security Overview | `/security` | `GET /api/securepay/security/overview` |
| Security Event Explorer | `/security` (Events tab) | `GET /api/securepay/security/events`, `GET /api/securepay/security/events/:uuid`, `POST /api/securepay/security/events/:uuid/review` |
| Incident Details | `/security` (Incidents tab) | `GET /api/securepay/security/incidents`, `GET /api/securepay/security/incidents/:uuid` |
| Account Freeze Controls | `/security` (Freezes tab) | `GET /api/securepay/security/freezes`, `POST /api/securepay/security/freezes`, `POST /api/securepay/security/freezes/:userId/release` |
| Audit & Ledger Integrity | `/security` (Integrity tab) | `GET /api/securepay/security/audit/integrity`, `GET /api/securepay/security/ledger/integrity` |
| Fraud Lab | `/security/fraud-lab` | `GET /api/securepay/security/scenarios`, `POST /api/securepay/security/scenarios/:id/run` |

All Security Center endpoints are admin-only and enforced server-side; hiding a control in React is never treated as authorization.

### Fraud Lab scenarios

Open **Security → Fraud Lab**, pick a scenario and press **Run scenario**. Every scenario is executed against synthetic sandbox retailers (`Sandbox Retailer A` / `Sandbox Retailer B`) and reports the steps, the expected result, the actual result, the rules triggered and whether it passed. A scenario only counts as passed when the backend verified the underlying security/business invariants.

| ID | Scenario | What it proves |
| --- | --- | --- |
| A | Normal activity | Healthy behaviour is permitted; no unnecessary freeze; ledger untouched |
| B | Transaction velocity anomaly | Velocity/amount rules fire, risk rises, the account is frozen and further payouts are refused |
| C | Suspicious beneficiary | Unverified/new beneficiary is checked and the payout is not silently allowed |
| D | Repeated payment request | One business effect; valid replay returns the original result; changed payload → HTTP 409 |
| E | Unauthorized resource access | Cross-tenant access denied (403); ownership cannot be bypassed by changing an id |
| F | Concurrent debit | Balance never goes negative; only affordable debits post; journals stay balanced |
| G | Invalid webhook | Wrong signature and tampered body are rejected; no state change; no credit |
| H | Duplicate webhook | Duplicate is detected and ignored; effect applied exactly once |
| I | Incident response | Holds applied, incident created, administrator review recorded, ledger unchanged for blocked ops |

Interpreting a failure: the result panel lists each step with a pass/fail marker and the reason. A failure means a security or business invariant did not hold — not merely that a request errored. Common causes are a missing `PINE_LABS_CLIENT_SECRET` (scenario G) or a database that has not been set up.

### Security test commands

```bash
# Full backend suite (existing + security)
npm test

# Individual suites
node --test tests/fraudEngine.test.js      # risk engine rules, thresholds, decisions
node --test tests/ledger.test.js           # double-entry invariants + concurrency
node --test tests/auditChain.test.js       # tamper detection, chain gaps, broken links
node --test tests/tenant.test.js           # BOLA / authorization
node --test tests/authHardening.test.js    # password policy, OTP hashing, lockout, session revocation
node --test tests/securityRoutes.test.js   # route registration + admin guarding

# Frontend production build
cd client && npm run build
```

### Known limitations

- In-memory replay buffer and single-process SSE; use Redis pub/sub behind `eventBus.js` for multiple instances.
- The audit hash chain detects modification of stored records but cannot prevent a fully privileged attacker from recomputing the whole chain. Anchor the tip hash in an external append-only store and restrict `UPDATE`/`DELETE` on `audit_logs` for stronger tamper evidence.
- The simulated ledger is not connected to real funds and is not a substitute for a regulated core-banking ledger.
- Beneficiary and device signals have no dedicated module yet, so the Fraud Lab passes them explicitly; production would source them from real beneficiary/device tables.
- Rate limiting uses the default in-memory store; a shared store is required for consistency across instances.
- The risk engine is rule-based and explainable by design — it is not a substitute for a tuned model, and thresholds must be tuned to real traffic before any production use.

### Before a real fintech production deployment

Certificate-verified database TLS, a managed secrets store, multi-instance rate limiting and SSE, real second-factor authentication for step-up, external audit checkpoints, migrations instead of schema sync, a formal threat model and penetration test, PCI-DSS/regulatory review, and real provider webhook secret rotation.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `Cannot connect to DB` | Check `DATABASE_URL` format and Neon SSL (`sslmode=require`). Verify network access. |
| `JWT_SECRET not set` | Set a strong random string in `.env`. |
| `CORS errors` | Add your frontend origin (`http://localhost:5173`) to `CORS_ORIGINS`. |
| `Sandbox not responding` | Ensure `PAYMENT_SANDBOX_ENABLED=true` and backend is running. |
| `SSE not updating dashboard` | Check browser console; SSE connects to backend on same origin via proxy. |
| `Tests fail` | Ensure Node version >=18. Run with `--test-force-exit`. |
| `Frontend 404 on routes` | Vite dev server handles client-side routing; in prod serve `index.html` for non-API routes. |

## Tips for Local Testing

1. **Full end-to-end demo:** Login → Dashboard → Simulator → Create order → Make payment → Watch timeline update → Check Dashboard KPIs update via SSE
2. **KYC flow:** Go to KYC page → Review a user’s 10-step journey → Verify/Reject documents
3. **Settlement:** Check Dashboard settlement card after payments
4. **Sandbox determinism:** Try amount `100.13`, notes `FAIL`, or card ending `0002` to see FAILED paths

## License

This is a learning project (`nexafin-backend-learning`). Use for educational/demo purposes.