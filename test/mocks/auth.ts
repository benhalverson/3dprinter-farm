import { vi } from "vitest";

export function mockAuth() {
  vi.mock("hono/cookie", async () => {
    const mod = (await import("hono/cookie")) as typeof import("hono/cookie");
    return {
      ...mod,
      getSignedCookie: vi.fn(async () => "mocked.jwt.token"),
    };
  });
  vi.mock("hono/jwt", async () => {
    const mod = (await import("hono/jwt")) as typeof import("hono/jwt");
    return {
      ...mod,
      verify: vi.fn(async () => ({ id: 1, email: "test@example.com" })),
    };
  });
}
