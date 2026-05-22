const ordersRepository = require("../repositories/ordersRepository");
const productsRepository = require("../repositories/productsRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");
const redis = require("../db/redis");
const db = require("../db/postgres");

async function withTransaction(callback) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createOrder({ customerId, items }) {
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    const error = new Error("customerId and items are required");
    error.status = 400;
    throw error;
  }

  // Deduplicate items submitted in the same payload
  const itemMap = new Map();
  for (const item of items) {
    if (!item.productId || !item.quantity || item.quantity <= 0) {
      const error = new Error("Invalid item format");
      error.status = 400;
      throw error;
    }
    if (itemMap.has(item.productId)) {
      itemMap.set(item.productId, itemMap.get(item.productId) + item.quantity);
    } else {
      itemMap.set(item.productId, item.quantity);
    }
  }
  const uniqueItems = Array.from(itemMap.entries()).map(([productId, quantity]) => ({
    productId,
    quantity,
  }));

  // Sort product IDs to prevent DB deadlocks
  uniqueItems.sort((a, b) => a.productId - b.productId);

  return await withTransaction(async (client) => {
    const enrichedItems = [];
    let calculatedTotal = 0;

    for (const item of uniqueItems) {
      const product = await productsRepository.getProductByIdForUpdate(
        item.productId,
        client
      );
      if (!product) {
        const error = new Error(`Product ${item.productId} not found`);
        error.status = 404;
        throw error;
      }
      if (product.stock < item.quantity) {
        const error = new Error(`Insufficient stock for ${product.name}`);
        error.status = 409;
        throw error;
      }

      const unitPrice = Number(product.price);
      calculatedTotal += unitPrice * item.quantity;

      enrichedItems.push({
        productId: product.id,
        quantity: item.quantity,
        unitPrice: unitPrice,
      });
    }

    // Fix JS float precision rounding
    calculatedTotal = Math.round(calculatedTotal * 100) / 100;

    for (const item of enrichedItems) {
      await productsRepository.decrementStock(item.productId, item.quantity, client);
    }

    const order = await ordersRepository.createOrder(
      {
        customerId,
        totalAmount: calculatedTotal,
        items: enrichedItems,
      },
      client
    );

    return order;
  });
}

async function chargeOrder({ orderId, idempotencyKey }) {
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}`);
    if (cached) {
      if (cached === "processing") {
        const error = new Error("Payment is already processing");
        error.status = 409;
        throw error;
      }
      return JSON.parse(cached);
    }

    const acquired = await redis.set(
      `idem:${idempotencyKey}`,
      "processing",
      "NX",
      "EX",
      3600
    );
    if (!acquired) {
      const error = new Error("Payment is already processing");
      error.status = 409;
      throw error;
    }
  }

  try {
    const order = await ordersRepository.getOrderById(orderId);
    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }

    if (order.status !== "PENDING") {
      const error = new Error("Only pending orders can be charged");
      error.status = 409;
      throw error;
    }

    const gatewayResponse = await paymentGateway.charge({
      orderId: order.id,
      amount: order.totalAmount,
    });

    const result = await withTransaction(async (client) => {
      // Re-lock the order inside the transaction to verify its status hasn't drifted
      const lockedOrder = await ordersRepository.getOrderByIdForUpdate(order.id, client);
      if (lockedOrder.status !== "PENDING") {
        const error = new Error("Only pending orders can be charged");
        error.status = 409;
        throw error;
      }

      const payment = await paymentsRepository.createPayment(
        {
          orderId: lockedOrder.id,
          amount: gatewayResponse.chargedAmount,
          providerTxnId: gatewayResponse.providerTxnId,
          status: "SUCCESS",
          idempotencyKey,
        },
        client
      );

      const updatedOrder = await ordersRepository.markOrderAsPaid(lockedOrder.id, client);
      return { order: updatedOrder, payment };
    });

    if (idempotencyKey) {
      await redis.set(
        `idem:${idempotencyKey}`,
        JSON.stringify(result),
        "EX",
        3600
      );
    }

    return result;
  } catch (err) {
    // If external charge fails, remove the "processing" flag so frontend can retry safely
    if (idempotencyKey) {
      await redis.del(`idem:${idempotencyKey}`);
    }
    throw err;
  }
}

async function processPaymentWebhook({
  providerEventId,
  orderId,
  eventType,
  payload,
}) {
  return await withTransaction(async (client) => {
    try {
      await paymentsRepository.createWebhookEvent(
        {
          providerEventId,
          orderId,
          eventType,
          payload,
        },
        client
      );
    } catch (err) {
      // Postgres error code 23505 = unique_violation
      if (err.code === "23505") {
        return { accepted: true, duplicate: true };
      }
      throw err;
    }

    if (eventType === "payment_succeeded") {
      const lockedOrder = await ordersRepository.getOrderByIdForUpdate(orderId, client);
      if (lockedOrder && lockedOrder.status === "PENDING") {
        await ordersRepository.markOrderAsPaid(orderId, client);
      }
    }

    return { accepted: true };
  });
}

async function getOrderById(orderId) {
  const order = await ordersRepository.getOrderWithDetails(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }
  return order;
}

async function listOrders(params) {
  return ordersRepository.listOrders(params);
}

module.exports = {
  createOrder,
  chargeOrder,
  processPaymentWebhook,
  getOrderById,
  listOrders,
};