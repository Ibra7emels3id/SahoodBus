import { describe, expect, it } from "vitest";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

function context(role: "admin" | "user"): TrpcContext {
  return {
    user: {
      id: 8,
      openId: "test-user",
      name: "مستخدم اختبار",
      email: "test@example.com",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("operations access scope", () => {
  it("allows administrators to select any branch", async () => {
    const caller = appRouter.createCaller(context("admin"));
    const result = await caller.operations.dashboard({ branchId: 9 });
    expect(result.filters.branchId).toBe(9);
  });
});
