import { describe, expect, it } from "vitest";
import { generateOrderNumber } from "../../src/utils/generateOrderNumber";

describe("Generate order number", () => {
  it("should generate a unique order number", async () => {
    const _dateString = "2024-12-01T22:43:03.169Z";
    const orderNumber = generateOrderNumber();
    expect(orderNumber).toMatch(/^\d{8}-\d{6}$/);
  });
});
