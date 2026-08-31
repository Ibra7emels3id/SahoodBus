import { TRPCError } from "@trpc/server";
import { reportFiltersSchema, userScopeSchema } from "../../shared/contracts";
import { eq } from "drizzle-orm";
import { userBranches } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";

/**
 * The operational layer is intentionally independent from screen components.
 * Database queries will be added behind these contracts as the first live
 * branches and trips are configured.
 */
export async function resolveScope(user: { id: number; role: "admin" | "user" }) {
  if (user.role === "admin") return { role: "admin" as const, branchId: null };
  const db = await getDb();
  const assignment = db
    ? (await db.select({ branchId: userBranches.branchId }).from(userBranches).where(eq(userBranches.userId, user.id)).limit(1))[0]
    : undefined;

  if (!assignment) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لم يتم ربط المستخدم بفرع بعد." });
  }
  return { role: "branch_user" as const, branchId: assignment.branchId };
}

export const operationsRouter = router({
  scope: protectedProcedure.query(async ({ ctx }) => {
    return userScopeSchema.parse(await resolveScope(ctx.user));
  }),

  dashboard: protectedProcedure.input(reportFiltersSchema.optional()).query(async ({ ctx, input }) => {
    const scope = await resolveScope(ctx.user);
    const branchId = scope.role === "branch_user" ? scope.branchId : input?.branchId ?? null;

    return {
      scope,
      filters: { ...input, branchId },
      message: "عقد لوحة التحكم جاهز لربط استعلامات قاعدة البيانات.",
    };
  }),
});
