import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProducts } from "../api";
import type { Product } from "../types";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true; // Use an active flag to prevent race conditions on slow network requests
    setLoading(true);

    listProducts(q)
      .then((data) => {
        if (active) {
          setProducts(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          console.error(err);
          setLoading(false);
        }
      });

    return () => {
      active = false; // Cleanup ignores the response if component unmounts or query changes
    };
  }, [q]);

  return (
    <div className="page">
      <h1>Products</h1>
      <div className="toolbar">
        <input
          type="text"
          value={q}
          placeholder="Search products"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {loading && <p>Loading...</p>}
      <ul className="product-grid">
        {products.map((p, idx) => (
          <li key={idx} className="product-card">
            <Link to={`/products/${p.id}`}>
              <h3>{p.name}</h3>
              <p className="sku">{p.sku}</p>
              <p className="price">${p.price}</p>
              <p className="stock">
                {p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}