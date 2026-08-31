import { TRPCError } from "@trpc/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { cashboxTransactions, expenses, reservations, trips } from "../../drizzle/schema";
import { cashboxTransactionInputSchema, expenseInputSchema, reportFiltersSchema, reservationInputSchema, tripInputSchema } from "../../shared/contracts";
import { getDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { resolveScope } from "./operations";

async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "قاعدة البيانات غير متاحة حالياً." });
  return db;
}

async function branchFor(user: { id: number; role: "admin" | "user" }, requestedBranchId?: number) {
  const scope = await resolveScope(user);
  if (scope.role === "branch_user") return scope.branchId;
  if (!requestedBranchId) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر الفرع المسؤول عن العملية." });
  return requestedBranchId;
}

export const bookingRouter = router({
  trips: router({
    list: protectedProcedure.query(async () => {
      const db = await database();
      return db.select().from(trips).orderBy(trips.departureAt);
    }),
    create: protectedProcedure.input(tripInputSchema).mutation(async ({ input }) => {
      const db = await database();
      const departureAt = new Date(`${input.departureDate}T${input.departureTime}:00`);
      if (Number.isNaN(departureAt.valueOf())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أو وقت الرحلة غير صحيح." });
      }
      const result = await db.insert(trips).values({
        routeName: input.routeName,
        departureAt,
        busNumber: input.busNumber,
        driverName: input.primaryDriverName,
        secondDriverName: input.secondDriverName ?? null,
        capacity: input.capacity,
      });
      return { id: Number(result[0].insertId), departureAt };
    }),
  }),

  reservations: router({
    list: protectedProcedure.input(reportFiltersSchema.optional()).query(async ({ ctx, input }) => {
      const db = await database();
      const scope = await resolveScope(ctx.user);
      const forcedBranchId = scope.role === "branch_user" ? scope.branchId : input?.branchId;
      return forcedBranchId
        ? db.select().from(reservations).where(eq(reservations.branchId, forcedBranchId)).orderBy(sql`${reservations.createdAt} desc`)
        : db.select().from(reservations).orderBy(sql`${reservations.createdAt} desc`);
    }),
    create: protectedProcedure.input(reservationInputSchema).mutation(async ({ ctx, input }) => {
      const db = await database();
      const branchId = await branchFor(ctx.user, input.branchId);
      if (input.paidAmount > input.price) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المسدد لا يمكن أن يتجاوز قيمة التذكرة." });
      const result = await db.insert(reservations).values({
        tripId: input.tripId,
        branchId,
        passengerName: input.passengerName,
        passengerPhone: input.passengerPhone,
        seatNumber: input.seatNumber,
        price: input.price.toFixed(2),
        paidAmount: input.paidAmount.toFixed(2),
        paymentStatus: input.paymentStatus,
        notes: input.notes ?? null,
      });
      return { id: Number(result[0].insertId), branchId };
    }),
  }),

  expenses: router({
    list: protectedProcedure.input(reportFiltersSchema.optional()).query(async ({ ctx, input }) => {
      const db = await database();
      const scope = await resolveScope(ctx.user);
      const forcedBranchId = scope.role === "branch_user" ? scope.branchId : input?.branchId;
      return forcedBranchId
        ? db.select().from(expenses).where(eq(expenses.branchId, forcedBranchId)).orderBy(sql`${expenses.occurredAt} desc`)
        : db.select().from(expenses).orderBy(sql`${expenses.occurredAt} desc`);
    }),
    create: protectedProcedure.input(expenseInputSchema).mutation(async ({ ctx, input }) => {
      const db = await database();
      const branchId = await branchFor(ctx.user, input.branchId);
      const result = await db.insert(expenses).values({
        branchId,
        category: input.category,
        amount: input.amount.toFixed(2),
        paidFrom: input.paidFrom,
        occurredAt: new Date(input.occurredAt),
        notes: input.notes ?? null,
        createdByUserId: ctx.user.id,
      });
      return { id: Number(result[0].insertId), branchId };
    }),
  }),

  cashbox: router({
    list: protectedProcedure.input(reportFiltersSchema.optional()).query(async ({ ctx, input }) => {
      const db = await database();
      const scope = await resolveScope(ctx.user);
      const branchId = scope.role === "branch_user" ? scope.branchId : input?.branchId;
      return branchId
        ? db.select().from(cashboxTransactions).where(eq(cashboxTransactions.branchId, branchId)).orderBy(sql`${cashboxTransactions.createdAt} desc`)
        : db.select().from(cashboxTransactions).orderBy(sql`${cashboxTransactions.createdAt} desc`);
    }),
    create: protectedProcedure.input(cashboxTransactionInputSchema).mutation(async ({ ctx, input }) => {
      const db = await database();
      const branchId = await branchFor(ctx.user, input.branchId);
      const result = await db.insert(cashboxTransactions).values({
        branchId,
        transactionType: input.transactionType,
        amount: input.amount.toFixed(2),
        reservationId: input.reservationId ?? null,
        description: input.description,
      });
      return { id: Number(result[0].insertId), branchId };
    }),
  }),

  reports: router({
    summary: protectedProcedure.input(reportFiltersSchema.optional()).query(async ({ ctx, input }) => {
      const db = await database();
      const scope = await resolveScope(ctx.user);
      const branchId = scope.role === "branch_user" ? scope.branchId : input?.branchId;
      const from = input?.from ? new Date(input.from) : undefined;
      const to = input?.to ? new Date(input.to) : undefined;
      const reservationConditions = [
        ...(branchId ? [eq(reservations.branchId, branchId)] : []),
        ...(input?.tripId ? [eq(reservations.tripId, input.tripId)] : []),
        ...(from && !Number.isNaN(from.valueOf()) ? [gte(reservations.createdAt, from)] : []),
        ...(to && !Number.isNaN(to.valueOf()) ? [lte(reservations.createdAt, to)] : []),
      ];
      const expenseConditions = [
        ...(branchId ? [eq(expenses.branchId, branchId)] : []),
        ...(from && !Number.isNaN(from.valueOf()) ? [gte(expenses.occurredAt, from)] : []),
        ...(to && !Number.isNaN(to.valueOf()) ? [lte(expenses.occurredAt, to)] : []),
      ];
      const reservationRows = reservationConditions.length
        ? await db.select().from(reservations).where(and(...reservationConditions))
        : await db.select().from(reservations);
      const expenseRows = expenseConditions.length
        ? await db.select().from(expenses).where(and(...expenseConditions))
        : await db.select().from(expenses);
      const revenue = reservationRows.reduce((total, item) => total + Number(item.paidAmount), 0);
      const expenseTotal = expenseRows.reduce((total, item) => total + Number(item.amount), 0);
      return { branchId: branchId ?? null, reservations: reservationRows.length, revenue, expenses: expenseTotal, balance: revenue - expenseTotal };
    }),
  }),
});
