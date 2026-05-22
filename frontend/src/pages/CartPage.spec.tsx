import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CartPage from "./CartPage";
import * as api from "../api";

// Mock the API layer to prevent actual network calls during testing
vi.mock("../api", () => ({
    createOrder: vi.fn().mockImplementation(() => {
        return new Promise((resolve) => setTimeout(() => resolve({ id: 1 }), 100)); // Simulate network delay
    }),
}));

// Mock the Cart Context to inject an existing item in the cart
vi.mock("../state/CartContext", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../state/CartContext")>();
    return {
        ...actual,
        useCart: () => ({
            items: [{ productId: 1, name: "Test Product", price: 10, quantity: 1 }],
            total: 10,
            remove: vi.fn(),
            clear: vi.fn(),
        }),
    };
});

describe("CartPage Security & UX", () => {
    it("disables the checkout button immediately after click to prevent double submits", async () => {
        render(
            <MemoryRouter>
                <CartPage />
            </MemoryRouter>
        );

        const button = screen.getByRole("button", { name: /checkout/i });

        // Simulate user clicking rapidly 3 times
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);

        // 1. Visual indication check: Ensure the button disables itself instantly
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent("Processing...");

        // 2. Network security check: Ensure API was triggered exactly ONCE despite 3 clicks
        expect(api.createOrder).toHaveBeenCalledTimes(1);
    });
});