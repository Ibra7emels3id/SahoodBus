import { decimal, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const branches = mysqlTable("branches", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  city: varchar("city", { length: 80 }).notNull(),
  isActive: mysqlEnum("isActive", ["yes", "no"]).default("yes").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const userBranches = mysqlTable("userBranches", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  branchId: int("branchId").notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
});

export const trips = mysqlTable("trips", {
  id: int("id").autoincrement().primaryKey(),
  routeName: varchar("routeName", { length: 180 }).notNull(),
  departureAt: timestamp("departureAt").notNull(),
  busNumber: varchar("busNumber", { length: 50 }).notNull(),
  driverName: varchar("driverName", { length: 120 }).notNull(),
  secondDriverName: varchar("secondDriverName", { length: 120 }),
  capacity: int("capacity").notNull(),
  status: mysqlEnum("status", ["open", "boarding", "departed", "closed"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const reservations = mysqlTable("reservations", {
  id: int("id").autoincrement().primaryKey(),
  tripId: int("tripId").notNull(),
  branchId: int("branchId").notNull(),
  passengerName: varchar("passengerName", { length: 120 }).notNull(),
  passengerPhone: varchar("passengerPhone", { length: 32 }).notNull(),
  seatNumber: varchar("seatNumber", { length: 8 }).notNull(),
  price: decimal("price", { precision: 12, scale: 2 }).notNull(),
  paidAmount: decimal("paidAmount", { precision: 12, scale: 2 }).notNull(),
  paymentStatus: mysqlEnum("paymentStatus", ["paid", "partial", "unpaid"]).default("unpaid").notNull(),
  reservationStatus: mysqlEnum("reservationStatus", ["confirmed", "pending", "cancelled"]).default("confirmed").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const expenses = mysqlTable("expenses", {
  id: int("id").autoincrement().primaryKey(),
  branchId: int("branchId").notNull(),
  category: varchar("category", { length: 80 }).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  paidFrom: mysqlEnum("paidFrom", ["cash", "bank"]).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  notes: text("notes"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const cashboxTransactions = mysqlTable("cashboxTransactions", {
  id: int("id").autoincrement().primaryKey(),
  branchId: int("branchId").notNull(),
  transactionType: mysqlEnum("transactionType", ["income", "expense", "transfer"]).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  reservationId: int("reservationId"),
  description: varchar("description", { length: 320 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type UserBranch = typeof userBranches.$inferSelect;
export type Trip = typeof trips.$inferSelect;
export type Reservation = typeof reservations.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type CashboxTransaction = typeof cashboxTransactions.$inferSelect;
