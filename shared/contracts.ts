import { z } from "zod";

/**
 * This file is the shared API contract. Client screens consume these shapes
 * through tRPC, while server routers validate the same inputs before persisting.
 */
export const userScopeSchema = z.object({
  role: z.enum(["admin", "branch_user"]),
  branchId: z.number().int().positive().nullable(),
});

export const reportFiltersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  branchId: z.number().int().positive().optional(),
  tripId: z.number().int().positive().optional(),
});

export const reservationStatusSchema = z.enum(["confirmed", "pending", "cancelled"]);
export const paymentStatusSchema = z.enum(["paid", "partial", "unpaid"]);

export const tripInputSchema = z.object({
  routeName: z.string().min(3).max(180),
  busNumber: z.string().min(2).max(50),
  primaryDriverName: z.string().min(3).max(120),
  secondDriverName: z.string().min(3).max(120).optional(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "أدخل تاريخ الرحلة بصيغة صحيحة."),
  departureTime: z.string().regex(/^\d{2}:\d{2}$/, "أدخل وقت المغادرة بصيغة صحيحة."),
  capacity: z.number().int().min(1).max(80),
});

export const reservationInputSchema = z.object({
  tripId: z.number().int().positive(),
  branchId: z.number().int().positive().optional(),
  passengerName: z.string().min(3).max(120),
  passengerPhone: z.string().min(7).max(24),
  seatNumber: z.string().min(1).max(8),
  price: z.number().nonnegative(),
  paidAmount: z.number().nonnegative(),
  paymentStatus: paymentStatusSchema,
  notes: z.string().max(500).optional(),
});

export const expenseInputSchema = z.object({
  branchId: z.number().int().positive(),
  category: z.string().min(2).max(80),
  amount: z.number().positive(),
  paidFrom: z.enum(["cash", "bank"]),
  occurredAt: z.number().int().positive(),
  notes: z.string().max(500).optional(),
});

export const cashboxTransactionInputSchema = z.object({
  branchId: z.number().int().positive().optional(),
  transactionType: z.enum(["income", "expense", "transfer"]),
  amount: z.number().positive(),
  reservationId: z.number().int().positive().optional(),
  description: z.string().min(3).max(320),
});

export type UserScope = z.infer<typeof userScopeSchema>;
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReservationInput = z.infer<typeof reservationInputSchema>;
export type TripInput = z.infer<typeof tripInputSchema>;
export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type CashboxTransactionInput = z.infer<typeof cashboxTransactionInputSchema>;
