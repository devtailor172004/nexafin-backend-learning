# NixaFin Backend + SecurePay Lab Operations Console

A payment / KYC / operations-intelligence backend built on **Express 5, Sequelize and MySQL**,
with a **React + Vite + Tailwind** operations console.

The original payment, auth, onboarding, KYC and admin modules are preserved. SecurePay Lab
adds reliability, security and observability as first-class features rather than more payment
methods.

---

## Repository layout

```
.
├── index.js                 # backend entry point
├── src/
│   ├── app.js               # express app + route mounting
│   ├── config/              # db, auto-sync, storage, polyfills
│   ├── controllers/         # existing modules + SecurePay ops
│   ├── middlewares/         # auth, rate limiting, idempotency
│   ├── models/              # Sequelize models
│   ├── routes/              # route definitions
│   ├── securepay/           # state machine, event engine, ledger, event bus, registry
│   ├── Services/Pinelabs/   # outbound provider calls + webhook signature verification
│   └── utils/               # helpers (idempotency, pagination, responses, logging)
├── tests/                   # node:test unit + smoke tests
└── client/                  # React operations console (separate package)
```

---

## Running it

### Backend

```bash
npm install
npm run dev          # node --env-file=.env --watch index.js
# or
npm start
```

Environment (`.env`):

| Key | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `DB_*` | MySQL connection |
| `JWT_SECRET` | Token signing |
| `CORS_ORIGINS` | Comma-separated browser origins allowed by CORS |
| `PINELABS_BASE_URL`, `PINE_LABS_CLIENT_SECRET` | Pine Labs provider + webhook signing |

The database schema is auto-synchronised by `src/config/syncDb.js` in non-production
(it creates new tables and adds/alters columns, including ENUM value changes).

### Frontend

```bash
cd client
npm install
npm run dev          # http://localhost:5173, proxies /api to localhost:3000
npm run build        # production build into client/dist
```

The dev server proxies `/api` to the backend, so no CORS configuration is needed locally.
When serving the built app from a different origin, set `VITE_API_BASE_URL` and add that
origin to the backend's `CORS_ORIGINS`.

### Tests

```bash
npm test             # node --test tests/*.test.js
```

---

## Phase 1 — what was implemented

### 1. Authorization fix on UPI payments (BOLA/IDOR)

`POST /api/payment/nxpay/order/:orderId/upi/payments` previously used the *optional*
`parseToken` middleware and looked the order up by UUID alone, so any caller could act on
another user's order.

Now it uses `verifyToken` and the controller scopes the lookup to the owner:

```js
const order = await PineLabsOrder.findOne({ where: { uuid: orderId, userId } });
```

A foreign order is now indistinguishable from a missing one.

### 2. Idempotency for money-moving endpoints

`src/models/IdempotencyKey.js` + `src/utils/idempotency.js`
(`claimIdempotency`, `markIdempotencyCompleted`, `markIdempotencyUnknown`).

This builds on the idempotency work already present on `main`; the order-creation and
checkout-initiation handlers previously imported the helpers without using them, and are now
fully wired.

Client usage:

```
POST /api/payment/nxpay/order
Authorization: Bearer <JWT>
Idempotency-Key: order-demo-001
Content-Type: application/json
```

| Situation | Behaviour |
| --- | --- |
| Same key + same body, already completed | Stored response replayed, provider **not** called again |
| Same key + different body | `409 Conflict` |
| Same key, still processing | `409 Conflict` (concurrent duplicate) |
| Same key, previous outcome `UNKNOWN` | `409 Conflict` — reconcile before retrying |
| Handler throws (provider/DB failure) | Key marked `UNKNOWN` — no blind retry of a money movement |

The `UNIQUE(userId, scope, key)` index is the concurrency guard: two simultaneous requests
with the same key race on INSERT and exactly one wins.

Applied scopes:

| Scope | Endpoint |
| --- | --- |
| `pine-labs:order:create` | `POST /api/payment/nxpay/order` |
| `pine-labs:order:initiate` | `POST /api/payment/nxpay/initiate` |
| `pine-labs:upi:<orderId>` | `POST /api/payment/nxpay/order/:orderId/upi/payments` |

> Note: a 4xx validation failure currently marks the key `UNKNOWN` (refusing later retries)
rather than releasing it. Releasing the key on 4xx would be a small improvement.

### 3. Webhook event ledger with deduplication

`src/models/ProviderWebhookEvent.js` (table `provider_webhook_events`) with
`UNIQUE(provider, webhookId)`. Every inbound webhook is claimed in the ledger before any
business state is touched.

* Duplicate + already `PROCESSED` → acknowledged, **not** re-applied
* Duplicate + still `PROCESSING` → acknowledged as in progress
* Duplicate + previously `FAILED` → retried with an incremented attempt count

Only a **sanitized** payload is stored (event type, order/payment ids, statuses, amounts,
error codes). Raw provider blobs are never persisted.

### 4. No environment-based signature bypass

* `POST /api/payment/nxpay/webhook` — production-style endpoint. Signature and timestamp are
  **always** verified. `src/Services/Pinelabs/webhookSignature.js` fails closed if
  `PINE_LABS_CLIENT_SECRET` is missing, and uses `crypto.timingSafeEqual`.
* `POST /api/payment/nxpay/mock/webhook` — separate local-development endpoint, no signature
  required. It returns `403` when `NODE_ENV=production`, so a missing secret can never be
  silently bypassed on a live system.

### 5. Payment state machine and event engine

`src/securepay/stateMachine.js` (pure, unit-tested):

```
CREATED → PENDING → AUTHORIZED → PROCESSED → REFUND_PENDING → REFUNDED
PENDING → FAILED | EXPIRED
AUTHORIZED → CANCELLED
REFUND_PENDING → REFUND_FAILED
```

Illegal regressions such as `PROCESSED → PENDING`, `FAILED → PROCESSED` or
`AUTHORIZED → PENDING` are refused. A rejected transition is recorded on the timeline as
`TRANSITION_REJECTED` rather than silently changing state. Payout events (`PAYOUT_*`) map to
internal events but deliberately do not move payment state.

`src/securepay/eventEngine.js` applies provider events and appends to the timeline.

### 6. Payment timeline and "why did this fail?"

Every order/payment action is appended to `payment_events`
(`src/models/PaymentEvent.js`) — order created, endpoint called, webhook received, state
transitioned, transition rejected.

`GET /api/securepay/payments/:uuid/explain` answers *why* a payment is in its current state:
stage, provider, error code, whether a webhook arrived, and whether a retry is advisable
(transient failures like timeouts are retryable; business declines are not).

### 7. Real-time operations layer

* `src/securepay/eventBus.js` — in-process event bus with a 100-event replay buffer
* `GET /api/securepay/stream?token=<JWT>` — Server-Sent Events stream with heartbeats and
  admin-role enforcement

> The bus is single-process. For multiple instances, swap the transport for Redis pub/sub
> behind the same publish/subscribe API.

### 8. Operations and Customer 360 APIs (all Admin-scoped)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/securepay/dashboard` | Today's KPIs, status/method breakdown, webhook health |
| GET | `/api/securepay/transactions/live` | Filterable, paginated transaction list |
| GET | `/api/securepay/providers/health` | 24h per-provider health from real traffic |
| GET | `/api/securepay/payments/:uuid/timeline` | Append-only event timeline |
| GET | `/api/securepay/payments/:uuid/explain` | Failure explanation |
| GET | `/api/securepay/customers/:uuid/overview` | Customer 360 |
| GET | `/api/securepay/stream` | Live SSE feed |

Provider health reports `NO_TRAFFIC` when there is no traffic instead of claiming `HEALTHY`.

### 9. Audit log

`src/models/AuditLog.js` + `src/securepay/auditLog.js` provide a centralized,
non-blocking audit trail for privileged actions.

### 10. Frontend operations console (`client/`)

Responsive React + Tailwind SPA with a desktop sidebar that becomes a mobile drawer:

* **Login** — JWT session
* **Dashboard** — KPIs, status/method breakdown, webhook health
* **Live Ops** — SSE event stream + auto-refreshing transaction table
* **Payments** — search/filter, detail drawer with timeline and explanation
* **Provider Health** — per-provider metrics
* **Customer 360** — profile, KYC, bank accounts, payments, risk signals, timeline
* **KYC Review** — approve/reject with the admin private password

---

## Phase 2 — what was implemented

### 1. Smart Provider Routing

`src/securepay/router.js`, backed by the capability registry in
`src/securepay/providerRegistry.js`.

`selectProvider({ method, currency, country })` ranks only **integrated and eligible**
providers, using live success rate first and latency as a tie-breaker. When nothing is
eligible it returns `NO_ELIGIBLE_PROVIDER` instead of guessing.

`evaluateFailover({ payment, webhookReceived })` implements the rule from the brief:

| Payment state | Failover | Recommended action |
| --- | --- | --- |
| No prior attempt | allowed | `PROCEED` |
| `PROCESSED` / `REFUND_*` | refused | `NONE` (already settled) |
| `FAILED` / `CANCELLED` / `EXPIRED` | allowed | `RETRY_WITH_ROUTER` |
| `PENDING`/`AUTHORIZED` with a provider attempt, no terminal webhook | **refused** | `CHECK_PAYMENT_STATUS_FIRST` |
| `CREATED`/`PENDING` otherwise | refused | `WAIT_OR_POLL` |

Exposed as `GET /api/securepay/routing/preview` and previewable in the UI.

### 2. Provider latency instrumentation

All 12 outbound Pine Labs calls now go through `src/Services/Pinelabs/httpClient.js`,
which times every request (including failures) into a rolling in-process window
(`src/securepay/providerMetrics.js`).

`GET /api/securepay/providers/health` returns `latencyMs`, `latencyP95Ms`,
`latencySamples` and `providerErrorRate` alongside the database-derived success rate, and
states the window explicitly. **Limitation:** latency is per-process and resets on restart;
multi-instance deployments need a shared store.

### 3. Reconciliation Center

`src/securepay/reconciliation.js` + `reconciliation_runs` / `reconciliation_exceptions`.

The matcher is a **pure function** so every exception type is unit tested:

| Type | Meaning |
| --- | --- |
| `MATCH` | Present and equal on both sides |
| `AMOUNT_MISMATCH` | Amounts differ (difference recorded) |
| `STATUS_MISMATCH` | Statuses differ |
| `MISSING_PROVIDER` | In our ledger, absent from the report |
| `MISSING_INTERNAL` | In the report, absent from our ledger |
| `DUPLICATE` | Same reference on either side more than once |
| `SETTLEMENT_MISMATCH` | Reported net differs from expected net |

Exception workflow: `OPEN → INVESTIGATING → RESOLVED`, or `IGNORE`, via
`PATCH /api/securepay/reconciliation/exceptions/:uuid`, with every step written to the
centralized audit log.

**Honesty note:** no real settlement file is connected. A simulated report is generated
that deliberately injects discrepancies on *distinct* rows, the run is stored with
`source: 'SIMULATED'`, and the exact injected changes are recorded on the run. The UI labels
these runs. `SETTLEMENT_MISMATCH` requires an *expected net settlement* (fee data), which is
not modelled yet, so it is neither injected nor detected.

### 4. Return-URL callback now uses the event engine

The callback previously assigned `payment.status` and `order.pluralStatus` directly. It now
routes both through the state machine (`applyInternalEvent`) and writes a `CALLBACK_RECEIVED`
timeline event, so an out-of-order callback can no longer regress a settled payment.

> Remaining hardening: the callback handler still bypasses signature verification in
> non-production, unlike the webhook endpoint. Left as-is so a dev checkout flow keeps
> working; it should be split into real/mock endpoints like the webhook was.

## Verification performed

| Check | Result |
| --- | --- |
| `npm test` (unit + module-graph smoke) | **59/59 pass** |
| Phase 1 end-to-end against the real MySQL database and a real HTTP server | **31/31 pass** |
| Phase 2 end-to-end (routing, failover, reconciliation, workflow, latency) | **30/30 pass** |
| Server boot smoke (`/`, ops route auth, mock webhook route) | pass |
| `client` production build (`vite build`) | pass |
| Dev proxy integration (frontend origin → backend API) | pass |

The end-to-end run verified, over HTTP against the real server and database:

* `400` when order creation is called without an `Idempotency-Key`
* a completed key replays the stored response **without reaching the provider**
* the same key with a different body is rejected with `409`
* another user acting on the order gets `404` and **no** idempotency record is claimed
* schema creation, webhook deduplication (no second ledger row)
* `PENDING → AUTHORIZED → PROCESSED` transitions and timeline events
* refusal of an illegal `PROCESSED → AUTHORIZED` regression, recorded on the timeline
* `404` for an unknown order with the ledger row marked `FAILED`
* rejection of an unsigned request on the real webhook endpoint

Temporary fixtures were removed afterwards.

---

## Not implemented yet (requested in the brief, scoped for later phases)

Honest status — these are **not** built, and no dummy data is shown for them in the UI:

**Phase 2 leftovers** — refunds/payouts execution (the `REFUND_*`/`PAYOUT_*` states and
events exist, but no refund/payout API), a real provider settlement-file import, and fee/
net-settlement modelling (needed before `SETTLEMENT_MISMATCH` can be detected in practice).

**Phase 3** — KYC journey timeline, liveness/face-match/document-OCR adapter abstractions,
bank verification provider abstraction, bill payments (mock provider first), international
payments with FX snapshots and 3DS/SCA, WebAuthn/passkeys for device biometric auth, and the
`PalmVerificationProvider` mock.

---

## Known issue found and fixed during this work

Every column declared as `DataTypes.JSON` in this database is physically **LONGTEXT** (checked
with `SHOW COLUMNS`), so the mysql2 driver returns those fields as *strings* rather than parsed
objects. Two real bugs followed from that:

1. **Idempotent replay returned a mangled body** — the stored response was replayed as a JSON
   *string* instead of the original object. Fixed with a `get` accessor on
   `IdempotencyKey.responseBody` (`src/utils/jsonColumn.js`).
2. **`{ ...record.rawResponse }` merges corrupted the column** — spreading a string writes
   `{"0":"{","1":"\"",…}`. All four occurrences (webhook, callback controller, order cancel)
   now use `mergeMaybeJson`.

This pattern may exist elsewhere in older modules; the remaining columns are still LONGTEXT
and could be migrated to real `JSON` columns in a future phase.

## Recommended follow-up

`node_modules/` and `.env` are currently **tracked** in git (from the initial commit). A
`.gitignore` has been added so new dependencies and build output are excluded, but the
already-tracked files remain. Consider:

```bash
git rm -r --cached node_modules .env
git commit -m "Stop tracking dependencies and environment secrets"
```

and rotate any secrets that were committed.
