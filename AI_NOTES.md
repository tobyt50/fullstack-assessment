# AI Usage Notes

## 1. Tools used

- **ChatGPT (GPT-4)**: Used for initial repository analysis, threat modeling, and defining the strategic scope of the assessment (prioritizing concurrency and money handling over cosmetic UI fixes).
- **Google AI Studio (Gemini 3.5 Flash)**: Used for rapid frontier reasoning, generating boilerplate test configurations (Vitest setup), and quick syntax refactoring on the frontend.
- **Google AI Studio (Gemini 3.1 Pro)**: Used for depth and context reasoning, particularly for handling the critical database transactions, row-level locking, and financial flows.
- **VS Code**: Primary IDE.

## 2. Prompt journal

### Prompt 1
```text
How do we start this assessment strategically? 
[Pasted the entire Take-home assessment README instructions]
```
**What it produced and what I did with it:**
ChatGPT produced a structured incident-response style breakdown. It correctly identified that the assessment is a trap for naive bug-fixing and suggested prioritizing core production failures (overselling, idempotency, floating-point money math, and polling memory leaks). I adopted its entire priority roadmap and explicitly followed its advice to not rewrite the app's architecture.

### Prompt 2
```text
Here is `backend/src/services/ordersService.js`. We need to fix the overselling issue under concurrent requests. Rewrite `createOrder` to use a database transaction.
```
**What it produced and what I did with it:**
Gemini Pro generated a `withTransaction` wrapper and correctly placed the stock checking and insertion logic inside it. However, it initially missed the requirement to use `SELECT ... FOR UPDATE` to actually lock the rows, and it didn't account for deadlocks. I kept the transaction structure but heavily modified the database locking mechanism.

### Prompt 3
```text
The frontend has a double-submit issue on the Cart checkout button and the Order pay button. How do we prevent this in React while awaiting the API?
```
**What it produced and what I did with it:**
Gemini Flash provided a standard `const [isSubmitting, setIsSubmitting] = useState(false)` pattern. It properly wrapped the API calls in a `try/finally` block. I kept this exactly as generated, as it is the industry-standard UI pattern for optimistic locking.

## 3. AI got it wrong

When prompting the AI to fix the order creation logic, it generated this dangerously insecure snippet for handling the checkout sum:

```javascript
// AI-generated insecure code
async function createOrder({ customerId, items, totalAmount }) {
  // ... (stock decrement logic)
  
  // Directly trusting the frontend's totalAmount
  const order = await ordersRepository.createOrder({
    customerId,
    totalAmount: totalAmount, // VULNERABILITY
    items: enrichedItems,
  });
  return order;
}
```

**What was wrong with it. How I found out. What I replaced it with:**
The AI naively passed the `totalAmount` directly from the client's HTTP request to the database. This is a critical security vulnerability; a malicious user could modify the request payload to set `totalAmount: 0.01` and steal inventory. 

I immediately rejected this. I rewrote the backend to completely ignore the client's `totalAmount`. Instead, my code iterates through the `items`, fetches the authoritative prices directly from the database inside the locked transaction, and computes the sum on the server using `Math.round(calculatedTotal * 100) / 100` to prevent JS floating-point precision errors.

## 4. Validation strategy

I did not trust the AI's generated code without proof. My validation strategy included:
- **Concurrency Tests**: Wrote a Jest test (`ordersService.spec.js`) that fired 5 simultaneous HTTP requests for an item with a stock of 1. Proved that only 1 succeeded and 4 received HTTP 409, validating the `FOR UPDATE` locks.
- **Frontend Security Tests**: Configured Vitest and React Testing Library from scratch to assert that rapid sequential clicks on the checkout button only result in exactly one mock API call.
- **Manual Network Inspection**: Verified that the `Idempotency-Key` was actually being attached to the header. Tested the memory leak fix by opening Chrome DevTools, navigating away from the order page, and ensuring the background polling successfully terminated.
- **Cross-Referencing Docs**: Manually reviewed PostgreSQL documentation on row-level locking to ensure that `FOR UPDATE` was sufficient without requiring heavier table locks.

## 5. What I did NOT delegate

I made several critical architectural decisions manually because AI often misses edge cases in distributed systems:

- **Money handling**: I refused to delegate the financial arithmetic to the AI. Standard AI output often uses floating-point multiplication `price * qty`, which introduces fraction-of-a-cent drift. I manually enforced integer/rounding logic.
- **Database Deadlock Prevention**: The AI's locking mechanism would have caused deadlocks if User A bought [Item 1, Item 2] and User B bought [Item 2, Item 1] concurrently. I manually added logic to sort the `productIds` numerically *before* acquiring the row locks to guarantee a sequential lock order.
- **Idempotency Locking**: AI suggested checking Redis with a `GET` followed by a `SET`. I knew this was a race condition in itself. I manually implemented a Redis `SET NX` (Not Exists) atomic lock to prevent simultaneous duplicate payment processing.
- **Rendering Untrusted Input**: AI suggested using DOMPurify to sanitize the React `dangerouslySetInnerHTML`. I decided that was over-engineered for a simple string and manually removed it entirely to rely on React's native string escaping.