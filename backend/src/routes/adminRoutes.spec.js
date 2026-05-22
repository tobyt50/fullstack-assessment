const request = require("supertest");
const app = require("../app");
const { ADMIN_TOKEN } = require("../config/env");

describe("Admin Routes Security", () => {
    it("rejects requests with no Authorization header", async () => {
        const res = await request(app)
            .post("/admin/products")
            .send({
                sku: "TEST-001",
                name: "Test Product",
                price: 100,
                stock: 5,
            });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Unauthorized");
    });

    it("rejects requests with an invalid token", async () => {
        const res = await request(app)
            .post("/admin/products")
            .set("Authorization", "Bearer WRONG_TOKEN_123")
            .send({
                sku: "TEST-001",
                name: "Test Product",
                price: 100,
                stock: 5,
            });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Forbidden");
    });

    // We don't test the successful 201 creation deeply here because we are only 
    // verifying the authentication boundary as requested by the assessment.
    it("allows access with the correct token", async () => {
        const res = await request(app)
            .post("/admin/products")
            .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
            .send({
                sku: `TEST-${Date.now()}`, // unique SKU
                name: "Test Product",
                price: 100,
                stock: 5,
            });

        expect(res.status).toBe(201);
        expect(res.body.sku).toBeDefined();
    });
});