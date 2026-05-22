import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { chargeOrder, getOrder } from "../api";
import type { Order } from "../types";

export default function OrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;

    const fetchOrder = () => {
      getOrder(id)
        .then((data: Order) => {
          if (active) setOrder(data);
        })
        .catch(console.error);
    };

    fetchOrder();

    // The interval is now assigned to a variable so we can clean it up
    const intervalId = setInterval(fetchOrder, 2000);

    // Cleanup function prevents memory leaks and state updates on unmounted components
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [id]);

  if (!order) return <p>Loading order...</p>;

  async function pay() {
    // strict null check required by TS inside async functions
    if (!order || paying) return;
    setPaying(true);
    try {
      // Generate idempotency key (using timestamp + order id)
      const idempotencyKey = `charge-order-${order.id}-${Date.now()}`;
      const result = await chargeOrder(order.id, idempotencyKey);
      setOrder(result.order);
    } catch (err) {
      console.error(err);
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="page">
      <h1>Order #{order.id}</h1>
      <p>
        Status: <span className={`status ${order.status}`}>{order.status}</span>
      </p>
      <p>Total: ${order.totalAmount}</p>

      <h2>Items</h2>
      <ul>
        {(order.items || []).map((item, idx) => (
          <li key={idx}>
            {item.name} x {item.quantity} @ ${item.unitPrice}
          </li>
        ))}
      </ul>

      <h2>Payments</h2>
      {(order.payments || []).length === 0 && <p>No payments yet.</p>}
      <ul>
        {(order.payments || []).map((p, idx) => (
          <li key={idx}>
            {p.status} - ${p.amount} ({p.providerTxnId})
          </li>
        ))}
      </ul>

      {order.status === "PENDING" && (
        <button className="primary" onClick={pay} disabled={paying}>
          {paying ? "Charging..." : "Pay now"}
        </button>
      )}
    </div>
  );
}