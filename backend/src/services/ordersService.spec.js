const request = require("supertest");
const app = require("../app");
const pool = require("../db/postgres");
const redis = require("../db/redis");

// 1. Mock the payment gateway to be fast and deterministic (removes the 10% random failure rate)
jest.mock("./paymentGateway", () => ({
  charge: jest.fn().mockResolvedValue({
    providerTxnId: `txn_mock_${Date.now()}`,
    chargedAmount: 10.00,
  }),
}));

// 2. Increase timeout to 30 seconds to account for remote Neon DB and Upstash Redis network latency
jest.setTimeout(30000);

describe("Core Backend Production Constraints", () => {
  afterAll(async () => {
    // Clean up connections so Jest exits cleanly
    await pool.end();
    await redis.quit();
  });

  it("prevents stock overselling under concurrent requests (Race Condition Fix)", async () => {
    // Create a dynamic SKU so repeated test runs don't violate the UNIQUE constraint
    const sku = `TEST-SKU-CONC-${Date.now()}`;

    // Setup a dummy product with exactly 1 item in stock
    const { rows } = await pool.query(
      `INSERT INTO products (sku, name, price, stock) VALUES ($1, 'Test Concurrency', 10.00, 1) RETURNING id`,
      [sku]
    );
    const productId = rows[0].id;

    // Define the exact same order request
    const makeOrder = () =>
      request(app).post("/orders").send({
        customerId: "test_customer",
        items: [{ productId, quantity: 1 }],
        totalAmount: 10.00,
      });

    // Fire 5 requests completely concurrently (simulating rapid network traffic)
    const responses = await Promise.all([
      makeOrder(),
      makeOrder(),
      makeOrder(),
      makeOrder(),
      makeOrder(),
    ]);

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    // Assert exact production safety: only ONE checkout should win the race
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(4);

    // Verify the stock is exactly 0 and never drops into negative numbers
    const stockRes = await pool.query(`SELECT stock FROM products WHERE id = $1`, [productId]);
    expect(stockRes.rows[0].stock).toBe(0);
  });

  it("prevents double-charging via idempotency constraints", async () => {
    const idempotencyKey = `idem-test-${Date.now()}`;

    // Setup a pending order
    const { rows } = await pool.query(
      `INSERT INTO orders (customer_id, total_amount, status) VALUES ('test_customer', 10.00, 'PENDING') RETURNING id`
    );
    const orderId = rows[0].id;

    // Define a charge request using the same idempotency key
    const chargeOrder = () =>
      request(app)
        .post("/payments/charge")
        .set("Idempotency-Key", idempotencyKey)
        .send({ orderId });

    // Fire concurrent charges simultaneously
    await Promise.all([chargeOrder(), chargeOrder(), chargeOrder()]);

    // Check the database to ensure exactly ONE payment record was written
    const payments = await pool.query(
      `SELECT * FROM payments WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    expect(payments.rows.length).toBe(1);
  });
});