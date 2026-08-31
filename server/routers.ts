import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { completeLocalPasswordReset, issueLocalPasswordReset, loginWithEmailPassword } from "./localAuth";
import { sendWasenderText } from "./wasender";
import { TRPCError } from "@trpc/server";
import { operationsRouter } from "./routers/operations";
import { bookingRouter } from "./routers/booking";
import { mongoBookingRouter } from "./routers/mongoBooking";
import { getMongoDb } from "./mongo";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(async ({ ctx }) => {
      const user = ctx.user;
      if (!user) return null;
      if (user.role === "admin" || !user.branchId) return { ...user, branchName: null };
      const branch = await (await getMongoDb()).collection("branches").findOne({ id: user.branchId }, { projection: { _id: 0, name: 1 } });
      return { ...user, branchName: branch?.name ? String(branch.name) : null };
    }),
    login: publicProcedure.input(z.object({ email: z.string().email(), password: z.string().min(8).max(256) })).mutation(async ({ input }) => {
      const result = await loginWithEmailPassword(input.email, input.password);
      if (!result) throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد الإلكتروني أو كلمة المرور غير صحيحة." });
      return result;
    }),
    passwordReset: router({
      request: publicProcedure.input(z.object({ email: z.string().email() })).mutation(async ({ input }) => {
        const reset = await issueLocalPasswordReset(input.email);
        if (reset) {
          await sendWasenderText({ to: reset.phone, text: `حافلة سهود\nرمز إعادة تعيين كلمة المرور: ${reset.code}\nصالح لمدة 10 دقائق. لا تشارك هذا الرمز مع أي شخص.`, bookingType: "password_reset", bookingCode: reset.resetId, mode: "automatic", category: "password_reset", auditPreview: "رمز إعادة تعيين كلمة المرور (المحتوى محمي)", createdByUserId: reset.userId });
        }
        return { accepted: true };
      }),
      confirm: publicProcedure.input(z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/), password: z.string().min(8).max(256) })).mutation(async ({ input }) => {
        const changed = await completeLocalPasswordReset(input);
        if (!changed) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز التحقق غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً ثم أعد المحاولة." });
        return { changed: true };
      }),
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  operations: operationsRouter,
  booking: bookingRouter,
  mongoBooking: mongoBookingRouter,
});

export type AppRouter = typeof appRouter;
