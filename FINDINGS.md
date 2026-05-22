# Findings

## Backend

### Issue: Inventory Overselling (Race Condition)
- **Where**: `backend/src/services/ordersService.js` (`createOrder` logic)
- **Why**: Stock was checked and then later decremented without transactional locking. Two concurrent requests reading the stock at the same time would both believe inventory was available, causing the stock to drop below zero.
- **Impact**: Critical Data Corruption / Overselling inventory leading to unfulfillable orders.
- **Fix**: Wrapped the flow in a PostgreSQL transaction (`BEGIN`/`COMMIT`) and utilized `SELECT ... FOR UPDATE` via `getProductByIdForUpdate` to enforce strict row-level locking. Also sorted incoming product IDs before locking to prevent database deadlocks during multi-item checkouts.
- **Trade-offs**: Row-level locking decreases throughput on highly contested, identical SKUs. This is a standard and acceptable trade-off for data integrity.

### Issue: Payment Double Charging (Lack of strict Idempotency)
- **Where**: `backend/src/services/ordersService.js` (`chargeOrder`) and `db/schema.sql`
- **Why**: The idempotency cache was using basic Redis gets/sets with no `NX` (Not Exists) locking, and the database lacked a UNIQUE constraint on the key. Rapid concurrent clicks bypassed the cache check entirely.
- **Impact**: Critical Financial Impact / Customers billed multiple times for the same order.
- **Fix**: Added a `UNIQUE` constraint to `idempotency_key` on the `payments` table. Integrated a Redis `SET NX` command to apply a distributed lock ("processing" state) to immediately block subsequent identical requests.
- **Trade-offs**: If the Node process crashes between acquiring the Redis lock and completing the database transaction, the key is stuck in "processing" for an hour. 

### Issue: Client-Controlled Monetary Arithmetic
- **Where**: `backend/src/services/ordersService.js` (`createOrder`)
- **Why**: The backend trusted the `totalAmount` payload directly from the frontend request without validation.
- **Impact**: Critical Security Risk / Customers could manually edit their network payload to set `totalAmount` to `0.01` and receive items virtually for free.
- **Fix**: The backend now completely ignores the client's `totalAmount`. It iterates through the locked product records, retrieves the authoritative database price, and strictly recalculates the total. Added JS floating point rounding (`Math.round(val * 100) / 100`) to prevent precision bugs.
- **Trade-offs**: A slight performance hit from iterating and calculating, but entirely necessary for financial systems.

### Issue: Duplicate Webhook Replay
- **Where**: `backend/src/services/ordersService.js` (`processPaymentWebhook`)
- **Why**: `providerEventId` was inserted without constraints. Re-sending a webhook marked the order as `PAID` repeatedly and triggered side effects twice.
- **Impact**: Corrupted analytics, potential duplicated fulfillment systems.
- **Fix**: Added a `UNIQUE` constraint on `provider_event_id` in `schema.sql`. Intercepted the Postgres error `23505` to safely acknowledge the duplicate without processing it.
- **Trade-offs**: None. This is standard webhook deduplication.

### Issue: Missing Admin Authorization
- **Where**: `backend/src/routes/adminRoutes.js`
- **Why**: Endpoint lacked middleware to verify the token, meaning anyone could update product stock and prices.
- **Impact**: Complete catalog takeover.
- **Fix**: Added Authorization header middleware comparing against the server's `ADMIN_TOKEN`.

---

## Frontend

### Issue: Cross-Site Scripting (XSS) Vulnerability
- **Where**: `frontend/src/pages/ProductDetailPage.tsx`
- **Why**: The UI used React's `dangerouslySetInnerHTML` to render the `product.description`. 
- **Impact**: Critical Security / Any malicious script stored in the database would be executed in the customer's browser.
- **Fix**: Removed `dangerouslySetInnerHTML` and fell back to standard React rendering which naturally escapes script injection. 
- **Trade-offs**: Legitimate HTML styling in descriptions is lost. A safe markdown parser or DOMPurify would be needed for rich text in the future.

### Issue: Double-Submit Vulnerabilities
- **Where**: `frontend/src/pages/CartPage.tsx`, `ProductDetailPage.tsx`, `OrderDetailPage.tsx`
- **Why**: Checkout and payment buttons lacked disabled states during asynchronous operations.
- **Impact**: Users clicking quickly fired duplicate network requests, leading to server strain and unhandled frontend state.
- **Fix**: Introduced `submitting` state variables that instantly disable the buttons upon first click, re-enabling them only on error via `finally` blocks.
- **Trade-offs**: None. Essential UX pattern.

### Issue: Memory Leak & Polling Stale State
- **Where**: `frontend/src/pages/OrderDetailPage.tsx`
- **Why**: `setInterval` fired API requests every 2 seconds without a cleanup function `clearInterval` on unmount.
- **Impact**: Navigating away from the order page left background requests firing indefinitely, causing memory leaks.
- **Fix**: Captured the interval ID and implemented the React `useEffect` cleanup return to destroy the interval when the component unmounts. Also used an `active` boolean flag to discard lingering API responses.
- **Trade-offs**: None.

### Issue: Search API Fetch Race Conditions
- **Where**: `frontend/src/pages/ProductsPage.tsx`
- **Why**: Rapidly typing in the search box fired off multiple non-cancelled fetches. A slower earlier request could resolve *after* a faster recent request, overwriting the UI with stale data.
- **Impact**: UI mismatch where the search term on screen doesn't match the products shown.
- **Fix**: Used an `active` unmount guard in the `useEffect` to safely ignore responses from outdated fetches.
- **Trade-offs**: Doesn't actually cancel the network request (which would save bandwidth via AbortController), but successfully mitigates the UI visual bug.