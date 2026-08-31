import { TRPCError } from "@trpc/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { calculateExternalOfficeRevenue, calculateOfficeRevenue } from "../../shared/bookingFinancials";
import { tripInputSchema } from "../../shared/contracts";
import { getMongoDb } from "../mongo";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { createLocalBranchUser, hasLocalPermission, listLocalUsers, resetLocalUserPassword, setLocalUserActive, updateLocalUser } from "../localAuth";
import { buildBookingMessage, createManualWhatsAppLink, createWasenderSession, disconnectWasenderSession, getActiveWasenderSession, getReconnectableWasenderSession, getWasenderConfigState, reconnectWasenderSession, refreshWasenderSession, sendWasenderText } from "../wasender";
import { getTripAutomationSettings, saveTripAutomationSettings } from "../tripAutomation";

const paymentMethodSchema = z.enum(["نقدي", "شبكة"]);
type PaymentMethod = z.infer<typeof paymentMethodSchema>;

const mongoTripSchema = tripInputSchema.extend({
  code: z.string().min(4).max(32),
  status: z.enum(["open", "boarding", "departed", "closed"]).default("open"),
  branchId: z.number().int().positive().optional(),
  sharedBranchId: z.number().int().positive().optional(),
});

const mongoReservationSchema = z.object({
  tripCode: z.string().min(4).max(32),
  seatNumber: z.number().int().positive(),
  passengerName: z.string().min(3).max(120),
  phone: z.string().min(7).max(24),
  nationality: z.string().min(2).max(64),
  passportNumber: z.string().min(2).max(64),
  birthDate: z.string().optional(),
  luggageCount: z.number().int().min(0).max(10).default(0),
  passengerType: z.enum(["بالغ", "طفل"]),
  paymentMethod: z.enum(["نقدي", "شبكة"]),
  ticketPrice: z.number().nonnegative(),
  driverCommission: z.number().nonnegative().default(0),
  branchId: z.number().int().positive().optional(),
});

const mongoReservationUpdateSchema = mongoReservationSchema.omit({ tripCode: true, branchId: true }).extend({ reservationCode: z.string().min(4).max(32), driverCommission: z.number().nonnegative().optional() });

const externalBookingInputSchema = z.object({
  routeName: z.string().min(3).max(160),
  travelDate: z.string().optional(),
  externalOfficeName: z.string().min(2).max(120),
  passengerName: z.string().min(3).max(120),
  phone: z.string().min(7).max(24),
  nationality: z.string().min(2).max(64),
  passportNumber: z.string().min(2).max(64),
  birthDate: z.string().optional(),
  luggageCount: z.number().int().min(0).max(10).default(0),
  passengerType: z.enum(["بالغ", "طفل"]),
  paymentMethod: z.enum(["نقدي", "شبكة"]),
  ticketPrice: z.number().nonnegative(),
  externalOfficeFee: z.number().nonnegative(),
  branchId: z.number().int().positive().optional(),
});

const trustInputSchema = z.object({
  tripCode: z.string().min(4).max(32),
  senderName: z.string().min(3).max(120),
  senderPhone: z.string().min(7).max(24),
  recipientName: z.string().min(3).max(120),
  recipientPhone: z.string().min(7).max(24),
  itemDescription: z.string().min(3).max(240),
  itemCount: z.number().int().min(1).max(50),
  fee: z.number().nonnegative(),
  driverCommission: z.number().nonnegative(),
  paymentMethod: paymentMethodSchema.default("نقدي"),
});

const expenseInputSchema = z.object({
  category: z.string().min(2).max(80),
  description: z.string().min(3).max(240),
  amount: z.number().positive(),
  paymentMethod: paymentMethodSchema.default("نقدي"),
  branchId: z.number().int().positive().optional(),
});

const cashVoucherInputSchema = z.object({
  type: z.enum(["receipt", "payment"]),
  partyName: z.string().min(2).max(120),
  category: z.string().min(2).max(80),
  description: z.string().min(3).max(240),
  amount: z.number().positive(),
  paymentMethod: paymentMethodSchema.default("نقدي"),
  branchId: z.number().int().positive().optional(),
});
const branchLocationUrlSchema = z.string().trim().url("أدخل رابط موقع الفرع بصيغة صحيحة.").max(500).nullable().optional();
function isSystemAdmin(user: { role: string; branchId?: number | null }) {
  return user.role === "admin" && !user.branchId;
}
function branchFilter(user: { role: string; branchId?: number | null }) {
  if (isSystemAdmin(user)) return {};
  if (!user.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الفرع غير مرتبط بفرع تشغيلي." });
  return { branchId: user.branchId };
}
function tripAccessFilter(user: { role: string; branchId?: number | null }) {
  if (isSystemAdmin(user)) return {};
  if (!user.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الفرع غير مرتبط بفرع تشغيلي." });
  return { $or: [{ branchId: user.branchId }, { sharedBranchId: user.branchId }] };
}
function canAccessTrip(user: { role: string; branchId?: number | null }, trip: Record<string, unknown>) {
  return isSystemAdmin(user) || (Boolean(user.branchId) && (Number(trip.branchId) === Number(user.branchId) || Number(trip.sharedBranchId) === Number(user.branchId)));
}
async function claimTripSeat(db: Awaited<ReturnType<typeof getMongoDb>>, tripCode: string, seatNumber: number) {
  return db.collection("trips").findOneAndUpdate(
    { code: tripCode, status: { $in: ["open", "boarding"] }, capacity: { $gte: seatNumber }, bookedSeats: { $ne: seatNumber } },
    { $addToSet: { bookedSeats: seatNumber }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
}

function requireBranchPermission(user: { role: string; permissions?: Array<"bookings" | "edit_prices" | "cashbox" | "reports" | "exports"> }, permission: "bookings" | "edit_prices" | "cashbox" | "reports" | "exports") {
  if (!hasLocalPermission(user, permission)) throw new TRPCError({ code: "FORBIDDEN", message: "حسابك لا يملك هذه الصلاحية. تواصل مع مدير النظام لتحديث صلاحياتك." });
}

async function branchMessageDetails(db: Awaited<ReturnType<typeof getMongoDb>>, branchId?: number) {
  if (!branchId) return { branchName: "", branchContactPhone: "", branchLocationUrl: "" };
  const [branch, branchUser] = await Promise.all([
    db.collection("branches").findOne({ id: branchId }, { projection: { _id: 0, name: 1, locationUrl: 1 } }),
    db.collection("localUsers").findOne({ branchId, isActive: true, phone: { $exists: true, $ne: "" } }, { projection: { _id: 0, phone: 1 } }),
  ]);
  return {
    branchName: branch?.name ? String(branch.name) : "",
    branchContactPhone: branchUser?.phone ? String(branchUser.phone) : "",
    branchLocationUrl: branch?.locationUrl ? String(branch.locationUrl) : "",
  };
}

function normalizePaymentMethod(value: unknown): PaymentMethod {
  return value === "شبكة" || value === "تحويل" ? "شبكة" : "نقدي";
}

function formatSaudiAmount(value: number) {
  return new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Math.max(0, value));
}

async function financialSummary(db: Awaited<ReturnType<typeof getMongoDb>>, filters?: { from?: string; to?: string; branchId?: number; tripCode?: string }) {
  const dateMatch = filters?.from || filters?.to ? { createdAt: { ...(filters.from ? { $gte: new Date(filters.from) } : {}), ...(filters.to ? { $lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}) } } : {};
  const branchMatch = filters?.branchId ? { branchId: filters.branchId } : {};
  const tripMatch = filters?.tripCode ? { tripCode: filters.tripCode } : {};
  const tripBranchMatch = filters?.branchId ? { branchId: filters.branchId } : {};
  const tripCodeMatch = filters?.tripCode ? { code: filters.tripCode } : {};
  const externalBookingsPromise = filters?.tripCode
    ? Promise.resolve([])
    : db.collection("externalBookings").find({ ...dateMatch, ...branchMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  const [reservations, externalBookings, trusts, expenses, vouchers, branches, trips] = await Promise.all([
    db.collection("reservations").find({ ...dateMatch, ...branchMatch, ...tripMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
    externalBookingsPromise,
    db.collection("trusts").find({ ...dateMatch, ...branchMatch, ...tripMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
    db.collection("expenses").find({ ...dateMatch, ...branchMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
    db.collection("cashVouchers").find({ ...dateMatch, ...branchMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
    db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1 } }).sort({ name: 1 }).toArray(),
    db.collection("trips").find({ ...dateMatch, ...tripBranchMatch, ...tripCodeMatch }, { projection: { _id: 0, code: 1, branchId: 1 } }).sort({ createdAt: -1 }).toArray(),
  ]);
  const tripCodes = trips.map(trip => String(trip.code));
  const operationReservations = tripCodes.length ? await db.collection("reservations").find({ ...dateMatch, tripCode: { $in: tripCodes } }, { projection: { _id: 0, tripCode: 1 } }).toArray() : [];
  const ticketRevenue = reservations.reduce((sum, item) => sum + Number(item.ticketPrice ?? 0), 0);
  const driverCommission = reservations.reduce((sum, item) => sum + Number(item.driverCommission ?? 0), 0);
  const officeRevenue = reservations.reduce((sum, item) => sum + Number(item.officeRevenue ?? 0), 0);
  const externalBookingGross = externalBookings.reduce((sum, item) => sum + Number(item.ticketPrice ?? 0), 0);
  const externalOfficeFee = externalBookings.reduce((sum, item) => sum + Number(item.externalOfficeFee ?? 0), 0);
  const externalOfficeRevenue = externalBookings.reduce((sum, item) => sum + Number(item.officeRevenue ?? 0), 0);
  const totalOfficeRevenue = officeRevenue + externalOfficeRevenue;
  const trustRevenue = trusts.reduce((sum, item) => sum + Number(item.officeRevenue ?? (Number(item.fee ?? item.price ?? 0) - Number(item.driverCommission ?? 0))), 0);
  const trustDriverCommission = trusts.reduce((sum, item) => sum + Number(item.driverCommission ?? 0), 0);
  const expensesTotal = expenses.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const cashReceiptTotal = vouchers.filter(item => item.type === "receipt").reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const cashPaymentTotal = vouchers.filter(item => item.type === "payment").reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const paymentBalances = { cashBalance: 0, networkBalance: 0 };
  const addPaymentBalance = (paymentMethod: unknown, amount: number) => {
    if (normalizePaymentMethod(paymentMethod) === "شبكة") paymentBalances.networkBalance += amount;
    else paymentBalances.cashBalance += amount;
  };
  reservations.forEach(item => addPaymentBalance(item.paymentMethod, Number(item.officeRevenue ?? 0)));
  externalBookings.forEach(item => addPaymentBalance(item.paymentMethod, Number(item.officeRevenue ?? 0)));
  trusts.forEach(item => addPaymentBalance(item.paymentMethod, Number(item.officeRevenue ?? (Number(item.fee ?? item.price ?? 0) - Number(item.driverCommission ?? 0)))));
  expenses.forEach(item => addPaymentBalance(item.paymentMethod, -Number(item.amount ?? 0)));
  vouchers.forEach(item => addPaymentBalance(item.paymentMethod, item.type === "receipt" ? Number(item.amount ?? 0) : -Number(item.amount ?? 0)));
  const balances = new Map<string, { branchId: number | null; branchName: string; bookingCount: number; officeRevenue: number; externalBookingCount: number; externalOfficeRevenue: number; trustRevenue: number; trustDriverCommission: number; expensesTotal: number; cashReceiptTotal: number; cashPaymentTotal: number; cashBalance: number; networkBalance: number }>();
  const branchNames = new Map(branches.map(branch => [Number(branch.id), String(branch.name)]));
  const ensureBalance = (branchId: unknown) => {
    const numericId = typeof branchId === "number" ? branchId : Number.isFinite(Number(branchId)) ? Number(branchId) : null;
    const key = numericId === null ? "unassigned" : String(numericId);
    if (!balances.has(key)) balances.set(key, { branchId: numericId, branchName: numericId === null ? "غير مرتبط بفرع" : branchNames.get(numericId) ?? "فرع غير معروف", bookingCount: 0, officeRevenue: 0, externalBookingCount: 0, externalOfficeRevenue: 0, trustRevenue: 0, trustDriverCommission: 0, expensesTotal: 0, cashReceiptTotal: 0, cashPaymentTotal: 0, cashBalance: 0, networkBalance: 0 });
    return balances.get(key)!;
  };
  branches.forEach(branch => ensureBalance(Number(branch.id)));
  const addBranchPaymentBalance = (balance: { cashBalance: number; networkBalance: number }, paymentMethod: unknown, amount: number) => { if (normalizePaymentMethod(paymentMethod) === "شبكة") balance.networkBalance += amount; else balance.cashBalance += amount; };
  reservations.forEach(item => { const balance = ensureBalance(item.branchId); const revenue = Number(item.officeRevenue ?? 0); balance.bookingCount += 1; balance.officeRevenue += revenue; addBranchPaymentBalance(balance, item.paymentMethod, revenue); });
  externalBookings.forEach(item => { const balance = ensureBalance(item.branchId); const revenue = Number(item.officeRevenue ?? 0); balance.externalBookingCount += 1; balance.externalOfficeRevenue += revenue; addBranchPaymentBalance(balance, item.paymentMethod, revenue); });
  trusts.forEach(item => { const balance = ensureBalance(item.branchId); const revenue = Number(item.officeRevenue ?? (Number(item.fee ?? item.price ?? 0) - Number(item.driverCommission ?? 0))); balance.trustRevenue += revenue; balance.trustDriverCommission += Number(item.driverCommission ?? 0); addBranchPaymentBalance(balance, item.paymentMethod, revenue); });
  expenses.forEach(item => { const balance = ensureBalance(item.branchId); const amount = Number(item.amount ?? 0); balance.expensesTotal += amount; addBranchPaymentBalance(balance, item.paymentMethod, -amount); });
  vouchers.forEach(item => { const balance = ensureBalance(item.branchId); const amount = Number(item.amount ?? 0); if (item.type === "receipt") balance.cashReceiptTotal += amount; else balance.cashPaymentTotal += amount; addBranchPaymentBalance(balance, item.paymentMethod, item.type === "receipt" ? amount : -amount); });
  const branchBalances = Array.from(balances.values()).map(balance => ({ ...balance, totalOfficeRevenue: balance.officeRevenue + balance.externalOfficeRevenue, totalBalance: balance.officeRevenue + balance.externalOfficeRevenue + balance.trustRevenue + balance.cashReceiptTotal - balance.expensesTotal - balance.cashPaymentTotal })).filter(balance => filters?.branchId ? balance.branchId === filters.branchId : true);
  const operations = new Map<string, { branchId: number | null; branchName: string; tripCount: number; bookingCount: number }>();
  const ensureOperation = (branchId: unknown) => {
    const numericId = typeof branchId === "number" ? branchId : Number.isFinite(Number(branchId)) ? Number(branchId) : null;
    const key = numericId === null ? "unassigned" : String(numericId);
    if (!operations.has(key)) operations.set(key, { branchId: numericId, branchName: numericId === null ? "غير مرتبط بفرع" : branchNames.get(numericId) ?? "فرع غير معروف", tripCount: 0, bookingCount: 0 });
    return operations.get(key)!;
  };
  branches.forEach(branch => ensureOperation(Number(branch.id)));
  const tripBranchIds = new Map(trips.map(trip => [String(trip.code), trip.branchId]));
  trips.forEach(trip => { ensureOperation(trip.branchId).tripCount += 1; });
  operationReservations.forEach(reservation => { ensureOperation(tripBranchIds.get(String(reservation.tripCode))).bookingCount += 1; });
  const branchOperations = Array.from(operations.values()).filter(operation => filters?.branchId ? operation.branchId === filters.branchId : true);
  return { reservations, externalBookings, trusts, expenses, vouchers, bookingCount: reservations.length, externalBookingCount: externalBookings.length, trustCount: trusts.length, expenseCount: expenses.length, voucherCount: vouchers.length, tripCount: trips.length, ticketRevenue, driverCommission, officeRevenue, externalBookingGross, externalOfficeFee, externalOfficeRevenue, totalOfficeRevenue, trustRevenue, trustDriverCommission, expensesTotal, cashReceiptTotal, cashPaymentTotal, cashBalance: paymentBalances.cashBalance, networkBalance: paymentBalances.networkBalance, totalBalance: totalOfficeRevenue + trustRevenue + cashReceiptTotal - expensesTotal - cashPaymentTotal, branchBalances, branchOperations };
}

async function assertSufficientPaymentBalance(
  db: Awaited<ReturnType<typeof getMongoDb>>,
  input: { amount: number; paymentMethod: PaymentMethod; branchId?: number },
  operationLabel: "المصروف" | "سند الصرف",
) {
  const summary = await financialSummary(db, input.branchId ? { branchId: input.branchId } : undefined);
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const available = paymentMethod === "شبكة" ? summary.networkBalance : summary.cashBalance;
  const spendable = Math.max(0, available);
  if (input.amount > spendable + Number.EPSILON) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يمكن حفظ ${operationLabel}: رصيد ${paymentMethod} المتاح هو ${formatSaudiAmount(spendable)} ر.س فقط، بينما المبلغ المطلوب ${formatSaudiAmount(input.amount)} ر.س.`,
    });
  }
}

export const mongoBookingRouter = router({
  whatsapp: router({
    send: protectedProcedure.input(z.object({ bookingType: z.enum(["reservation", "external"]), bookingCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const filter = branchFilter(ctx.user);
      const collection = input.bookingType === "reservation" ? "reservations" : "externalBookings";
      const codeField = input.bookingType === "reservation" ? "reservationCode" : "externalBookingCode";
      const item = await db.collection(collection).findOne({ [codeField]: input.bookingCode, ...filter });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود أو لا تملك صلاحية الوصول إليه." });
      const trip = input.bookingType === "reservation" ? await db.collection("trips").findOne({ code: item.tripCode }, { projection: { _id: 0, routeName: 1, departureAt: 1 } }) : null;
      const currentBranch = await branchMessageDetails(db, Number(item.branchId) || undefined);
      const text = buildBookingMessage({ ...item, branchName: currentBranch.branchName || item.branchName, branchContactPhone: currentBranch.branchContactPhone || item.branchContactPhone, branchLocationUrl: currentBranch.branchLocationUrl || item.branchLocationUrl, ...(trip ?? {}) }, input.bookingType);
      return sendWasenderText({ to: String(item.phone), text, bookingType: input.bookingType, bookingCode: input.bookingCode, mode: "manual", createdByUserId: ctx.user.id });
    }),
    manualLink: protectedProcedure.input(z.object({ bookingType: z.enum(["reservation", "external"]), bookingCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const filter = branchFilter(ctx.user);
      const collection = input.bookingType === "reservation" ? "reservations" : "externalBookings";
      const codeField = input.bookingType === "reservation" ? "reservationCode" : "externalBookingCode";
      const item = await db.collection(collection).findOne({ [codeField]: input.bookingCode, ...filter });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود أو لا تملك صلاحية الوصول إليه." });
      const trip = input.bookingType === "reservation" ? await db.collection("trips").findOne({ code: item.tripCode }, { projection: { _id: 0, routeName: 1, departureAt: 1 } }) : null;
      const currentBranch = await branchMessageDetails(db, Number(item.branchId) || undefined);
      const text = buildBookingMessage({ ...item, branchName: currentBranch.branchName || item.branchName, branchContactPhone: currentBranch.branchContactPhone || item.branchContactPhone, branchLocationUrl: currentBranch.branchLocationUrl || item.branchLocationUrl, ...(trip ?? {}) }, input.bookingType);
      return createManualWhatsAppLink({ to: String(item.phone), text, bookingType: input.bookingType, bookingCode: input.bookingCode, createdByUserId: ctx.user.id });
    }),
    messages: protectedProcedure.input(z.object({ bookingType: z.enum(["reservation", "external"]), bookingCode: z.string().min(4) }).optional()).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const projection = { _id: 0, messagePreview: 1, recipientPhone: 1, mode: 1, attempt: 1, status: 1, providerMessageId: 1, errorMessage: 1, bookingType: 1, bookingCode: 1, createdAt: 1, sentAt: 1, updatedAt: 1 };
      if (input) {
        const filter = branchFilter(ctx.user);
        const codeField = input.bookingType === "reservation" ? "reservationCode" : "externalBookingCode";
        const booking = await db.collection(input.bookingType === "reservation" ? "reservations" : "externalBookings").findOne({ [codeField]: input.bookingCode, ...filter }, { projection: { _id: 0 } });
        if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود." });
        return db.collection("whatsappMessages").find({ bookingType: input.bookingType, bookingCode: input.bookingCode }, { projection }).sort({ createdAt: -1 }).limit(50).toArray();
      }
      if (ctx.user.role === "admin") return db.collection("whatsappMessages").find({}, { projection }).sort({ createdAt: -1 }).limit(500).toArray();
      const [reservations, externalBookings] = await Promise.all([db.collection("reservations").find(branchFilter(ctx.user), { projection: { _id: 0, reservationCode: 1 } }).toArray(), db.collection("externalBookings").find(branchFilter(ctx.user), { projection: { _id: 0, externalBookingCode: 1 } }).toArray()]);
      const allowedCodes = [...reservations.map(item => ({ bookingType: "reservation", bookingCode: item.reservationCode })), ...externalBookings.map(item => ({ bookingType: "external", bookingCode: item.externalBookingCode }))];
      if (!allowedCodes.length) return [];
      return db.collection("whatsappMessages").find({ $or: allowedCodes }, { projection }).sort({ createdAt: -1 }).limit(500).toArray();
    }),
  }),
  admin: router({
    whatsapp: router({
      config: adminProcedure.query(async () => {
        const [state, session, reconnectableSession] = await Promise.all([getWasenderConfigState(), getActiveWasenderSession(), getReconnectableWasenderSession()]);
        return { ...state, session, reconnectableSession };
      }),
      createSession: adminProcedure.input(z.object({ name: z.string().trim().min(2).max(80), phoneNumber: z.string().trim().min(7).max(24) })).mutation(async ({ ctx, input }) => createWasenderSession({ ...input, req: ctx.req })),
      recreateSession: adminProcedure.input(z.object({ phoneNumber: z.string().trim().min(7).max(24) })).mutation(async ({ ctx, input }) => {
        const currentSession = await getActiveWasenderSession();
        if (!currentSession) throw new TRPCError({ code: "NOT_FOUND", message: "لا توجد جلسة واتساب محفوظة لإعادة إنشائها." });
        return createWasenderSession({ name: currentSession.name, phoneNumber: input.phoneNumber, req: ctx.req });
      }),
      refreshStatus: adminProcedure.mutation(async () => refreshWasenderSession()),
      disconnect: adminProcedure.mutation(async () => disconnectWasenderSession()),
      reconnect: adminProcedure.mutation(async () => reconnectWasenderSession()),
      messages: adminProcedure.input(z.object({ reservationCode: z.string().optional(), externalBookingCode: z.string().optional(), status: z.string().optional(), category: z.string().optional() }).optional()).query(async ({ input }) => {
        const db = await getMongoDb();
        const filter = { ...(input?.reservationCode ? { reservationCode: input.reservationCode } : input?.externalBookingCode ? { externalBookingCode: input.externalBookingCode } : {}), ...(input?.status ? { status: input.status } : {}), ...(input?.category ? { category: input.category } : {}) };
        return db.collection("whatsappMessages").find(filter, { projection: { _id: 0, encryptedMessage: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
      }),
      retry: adminProcedure.input(z.object({ bookingType: z.enum(["reservation", "external", "trust"]), bookingCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
        const db = await getMongoDb();
        const source = input.bookingType === "reservation" ? { collection: "reservations", codeField: "reservationCode", phoneField: "phone" } : input.bookingType === "external" ? { collection: "externalBookings", codeField: "externalBookingCode", phoneField: "phone" } : { collection: "trusts", codeField: "trustCode", phoneField: "recipientPhone" };
        const item = await db.collection(source.collection).findOne({ [source.codeField]: input.bookingCode });
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "سجل الرسالة المرتبط غير موجود." });
        const trip = input.bookingType === "external" ? null : await db.collection("trips").findOne({ code: item.tripCode }, { projection: { _id: 0, routeName: 1, departureAt: 1 } });
        const branch = await branchMessageDetails(db, Number(item.branchId) || undefined);
        const text = buildBookingMessage({ ...item, branchName: branch.branchName || item.branchName, branchContactPhone: branch.branchContactPhone || item.branchContactPhone, branchLocationUrl: branch.branchLocationUrl || item.branchLocationUrl, ...(trip ?? {}) }, input.bookingType);
        return sendWasenderText({ to: String(item[source.phoneField] ?? ""), text, bookingType: input.bookingType, bookingCode: input.bookingCode, mode: "manual", category: "manual_retry", createdByUserId: ctx.user.id });
      }),
    }),
    automation: router({
      settings: adminProcedure.query(async () => getTripAutomationSettings()),
      updateSettings: adminProcedure.input(z.object({ reminderEnabled: z.boolean(), reminderLeadMinutes: z.number().int().min(15).max(1440), feedbackEnabled: z.boolean(), feedbackDelayMinutes: z.number().int().min(30).max(10080), googleReviewUrl: z.string().trim().max(500) })).mutation(async ({ input }) => saveTripAutomationSettings(input)),
      feedback: adminProcedure.query(async () => {
        const db = await getMongoDb();
        const feedback = await db.collection("customerFeedback").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray() as Array<Record<string, any>>;
        const reservations = await db.collection("reservations").find({ reservationCode: { $in: feedback.map(item => String(item.bookingCode)) } }, { projection: { _id: 0, reservationCode: 1, passengerName: 1, tripCode: 1 } }).toArray();
        const reservationMap = new Map(reservations.map(item => [String(item.reservationCode), item]));
        return feedback.map(item => {
          const reservation = reservationMap.get(String(item.bookingCode));
          return { bookingCode: String(item.bookingCode ?? ""), recipientPhone: String(item.recipientPhone ?? ""), rating: String(item.rating ?? "issue"), issueText: String(item.issueText ?? ""), createdAt: item.createdAt ?? null, reservation: reservation ? { passengerName: String(reservation.passengerName ?? ""), tripCode: String(reservation.tripCode ?? "") } : null };
        });
      }),
    }),
    branches: router({
      list: adminProcedure.query(async () => {
        const db = await getMongoDb();
        return db.collection("branches").find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
      }),
      create: adminProcedure.input(z.object({ name: z.string().min(2).max(120), locationUrl: branchLocationUrlSchema })).mutation(async ({ input }) => {
        const db = await getMongoDb();
        const name = input.name.trim();
        const existing = await db.collection("branches").findOne({ name });
        if (existing) {
          if (input.locationUrl !== undefined) await db.collection("branches").updateOne({ id: existing.id }, { $set: { locationUrl: input.locationUrl || null, updatedAt: new Date() } });
          return { id: Number(existing.id), name: String(existing.name), locationUrl: input.locationUrl ?? existing.locationUrl ?? null };
        }
        const branch = { id: Date.now(), name, locationUrl: input.locationUrl || null, createdAt: new Date(), updatedAt: new Date(), isActive: true };
        await db.collection("branches").insertOne(branch);
        return { id: branch.id, name: branch.name, locationUrl: branch.locationUrl };
      }),
    }),
    users: router({
      list: adminProcedure.query(async () => {
        const db = await getMongoDb();
        const [users, branches] = await Promise.all([listLocalUsers(), db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1, locationUrl: 1 } }).toArray()]);
        const branchDetails = new Map(branches.map(branch => [Number(branch.id), { name: String(branch.name), locationUrl: branch.locationUrl ? String(branch.locationUrl) : null }]));
        return users.map(user => ({ ...user, branchName: user.branchId ? branchDetails.get(user.branchId)?.name ?? "فرع غير معروف" : null, branchLocationUrl: user.branchId ? branchDetails.get(user.branchId)?.locationUrl ?? null : null }));
      }),
      create: adminProcedure.input(z.object({ name: z.string().min(3).max(120), email: z.string().email(), password: z.string().min(8).max(256), phone: z.string().trim().min(7).max(24), branchId: z.number().int().positive().optional(), branchName: z.string().min(2).max(120).optional(), branchLocationUrl: branchLocationUrlSchema, permissions: z.array(z.enum(["bookings", "edit_prices", "cashbox", "reports", "exports"])).optional() })).mutation(async ({ input }) => {
        const db = await getMongoDb();
        let branchId = input.branchId;
        if (!branchId && input.branchName?.trim()) {
          const name = input.branchName.trim();
          const existing = await db.collection("branches").findOne({ name });
          if (existing) {
            branchId = Number(existing.id);
            if (input.branchLocationUrl !== undefined) await db.collection("branches").updateOne({ id: branchId }, { $set: { locationUrl: input.branchLocationUrl || null, updatedAt: new Date() } });
          } else { branchId = Date.now(); await db.collection("branches").insertOne({ id: branchId, name, locationUrl: input.branchLocationUrl || null, createdAt: new Date(), updatedAt: new Date(), isActive: true }); }
        }
        if (branchId && input.branchLocationUrl !== undefined && input.branchId) await db.collection("branches").updateOne({ id: branchId }, { $set: { locationUrl: input.branchLocationUrl || null, updatedAt: new Date() } });
        const user = await createLocalBranchUser({ ...input, branchId });
        if (!user) throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم بالفعل." });
        return user;
      }),
      update: adminProcedure.input(z.object({ id: z.number().int().positive(), name: z.string().min(3).max(120), email: z.string().email(), phone: z.string().trim().min(7).max(24).nullable(), branchId: z.number().int().positive().nullable().optional(), branchLocationUrl: branchLocationUrlSchema, permissions: z.array(z.enum(["bookings", "edit_prices", "cashbox", "reports", "exports"])).optional() })).mutation(async ({ input }) => {
        const result = await updateLocalUser(input);
        if (result.reason === "duplicate-email") throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم بالفعل." });
        if (!result.updated) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود." });
        if (input.branchId && input.branchLocationUrl !== undefined) await (await getMongoDb()).collection("branches").updateOne({ id: input.branchId }, { $set: { locationUrl: input.branchLocationUrl || null, updatedAt: new Date() } });
        return { id: input.id };
      }),
      setActive: adminProcedure.input(z.object({ id: z.number().int().positive(), isActive: z.boolean() })).mutation(async ({ input, ctx }) => {
        if (input.id === ctx.user.id && !input.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إيقاف حساب المدير الحالي." });
        if (!(await setLocalUserActive(input.id, input.isActive))) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود." });
        return { id: input.id, isActive: input.isActive };
      }),
      resetPassword: adminProcedure.input(z.object({ id: z.number().int().positive(), password: z.string().min(8).max(256) })).mutation(async ({ input }) => {
        if (!(await resetLocalUserPassword(input.id, input.password))) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود." });
        return { id: input.id, changed: true };
      }),
    }),
    exports: router({
      backup: adminProcedure.query(async () => {
        const db = await getMongoDb();
        const [users, branches, trips, reservations, externalBookings, trusts, expenses, cashVouchers, whatsappMessages, wasenderSessions] = await Promise.all([
          listLocalUsers(),
          db.collection("branches").find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(),
          db.collection("trips").find({}, { projection: { _id: 0 } }).sort({ departureAt: -1 }).toArray(),
          db.collection("reservations").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("externalBookings").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("trusts").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("expenses").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("cashVouchers").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("whatsappMessages").find({}, { projection: { _id: 0, messagePreview: 1, recipientPhone: 1, mode: 1, attempt: 1, status: 1, providerMessageId: 1, errorMessage: 1, bookingType: 1, bookingCode: 1, createdAt: 1, sentAt: 1, updatedAt: 1 } }).sort({ createdAt: -1 }).toArray(),
          db.collection("wasenderSessions").find({}, { projection: { _id: 0, providerSessionId: 1, name: 1, phoneNumber: 1, status: 1, isActive: 1, createdAt: 1, updatedAt: 1 } }).sort({ createdAt: -1 }).toArray(),
        ]);
        return { generatedAt: new Date(), users, branches, trips, reservations, externalBookings, trusts, expenses, cashVouchers, whatsappMessages, wasenderSessions };
      }),
    }),
  }),
  trips: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await getMongoDb();
      const [trips, branches] = await Promise.all([
        db.collection("trips").find(tripAccessFilter(ctx.user), { projection: { _id: 0 } }).sort({ createdAt: -1, departureAt: -1 }).toArray(),
        db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray(),
      ]);
      const branchNames = new Map(branches.map(branch => [Number(branch.id), String(branch.name)]));
      return trips.map(trip => ({
        code: String(trip.code ?? ""),
        routeName: String(trip.routeName ?? ""),
        busNumber: String(trip.busNumber ?? ""),
        primaryDriverName: String(trip.primaryDriverName ?? ""),
        secondDriverName: trip.secondDriverName ? String(trip.secondDriverName) : null,
        capacity: Number(trip.capacity ?? 0),
        bookedSeats: Array.isArray(trip.bookedSeats) ? trip.bookedSeats.map(Number) : [],
        status: String(trip.status ?? "open"),
        departureAt: trip.departureAt ?? null,
        createdAt: trip.createdAt ?? null,
        branchId: trip.branchId ? Number(trip.branchId) : null,
        branchName: trip.branchId ? branchNames.get(Number(trip.branchId)) ?? "فرع غير معروف" : "غير مرتبط بفرع",
        sharedBranchId: trip.sharedBranchId ? Number(trip.sharedBranchId) : null,
        sharedBranchName: trip.sharedBranchId ? branchNames.get(Number(trip.sharedBranchId)) ?? "فرع غير معروف" : null,
      }));
    }),
    shareableBranches: protectedProcedure.query(async ({ ctx }) => {
      requireBranchPermission(ctx.user, "bookings");
      const db = await getMongoDb();
      const filter = ctx.user.branchId ? { id: { $ne: ctx.user.branchId } } : {};
      return db.collection("branches").find(filter, { projection: { _id: 0, id: 1, name: 1 } }).sort({ name: 1 }).toArray();
    }),
    create: protectedProcedure.input(mongoTripSchema).mutation(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "bookings");
      const db = await getMongoDb();
      const existing = await db.collection("trips").findOne({ code: input.code });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "رقم الرحلة مستخدم بالفعل." });
      const departureAt = new Date(`${input.departureDate}T${input.departureTime}:00`);
      if (Number.isNaN(departureAt.valueOf())) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أو وقت الرحلة غير صحيح." });
      const branchId = isSystemAdmin(ctx.user) ? input.branchId : branchFilter(ctx.user).branchId;
      const sharedBranchId = input.sharedBranchId;
      if (sharedBranchId && !branchId) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد فرع الرحلة الأساسي قبل اختيار فرع مشارك." });
      if (sharedBranchId && Number(sharedBranchId) === Number(branchId)) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن أن يكون الفرع المشارك هو فرع الرحلة الأساسي نفسه." });
      if (sharedBranchId && !(await db.collection("branches").findOne({ id: sharedBranchId, isActive: { $ne: false } }, { projection: { _id: 1 } }))) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع المشارك غير موجود أو غير نشط." });
      await db.collection("trips").insertOne({
        code: input.code,
        routeName: input.routeName,
        busNumber: input.busNumber,
        primaryDriverName: input.primaryDriverName,
        secondDriverName: input.secondDriverName ?? null,
        capacity: input.capacity,
        bookedSeats: [],
        status: input.status,
        departureAt,
        branchId,
        sharedBranchId: sharedBranchId ?? null,
        createdByUserId: ctx.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { code: input.code };
    }),
    update: adminProcedure.input(mongoTripSchema).mutation(async ({ input }) => {
      const db = await getMongoDb();
      const result = await db.collection("trips").updateOne({ code: input.code }, { $set: { ...input, departureAt: new Date(`${input.departureDate}T${input.departureTime}:00`), updatedAt: new Date() } });
      if (!result.matchedCount) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة." });
      return { code: input.code };
    }),
    driverManifest: protectedProcedure.input(z.object({ tripCode: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode, ...tripAccessFilter(ctx.user) }, { projection: { _id: 0 } });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة أو لا تملك صلاحية الوصول إليها." });
      const [reservations, branch, trusts] = await Promise.all([
        db.collection("reservations").find({ tripCode: input.tripCode, ...branchFilter(ctx.user) }, { projection: { _id: 0, reservationCode: 1, passengerName: 1, phone: 1, seatNumber: 1, luggageCount: 1, passengerType: 1, nationality: 1, paymentMethod: 1, branchContactPhone: 1 } }).sort({ seatNumber: 1 }).toArray(),
        trip.branchId ? db.collection("branches").findOne({ id: Number(trip.branchId) }, { projection: { _id: 0, name: 1, locationUrl: 1 } }) : null,
        db.collection("trusts").find({ tripCode: input.tripCode, ...branchFilter(ctx.user) }, { projection: { _id: 0, trustCode: 1, senderName: 1, senderPhone: 1, recipientName: 1, recipientPhone: 1, itemDescription: 1, itemCount: 1, status: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray(),
      ]);
      return { trip, branch: branch ?? null, reservations, trusts };
    }),
    start: protectedProcedure.input(z.object({ tripCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const scope = { code: input.tripCode, ...tripAccessFilter(ctx.user) };
      const result = await db.collection("trips").updateOne(scope, { $set: { status: "departed", startedAt: new Date(), updatedAt: new Date() } });
      if (!result.matchedCount) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة أو لا تملك صلاحية بدءها." });
      return { tripCode: input.tripCode, status: "departed" as const };
    }),
  }),
  reservations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await getMongoDb();
      const [reservations, trips, branches] = await Promise.all([
        db.collection("reservations").find(branchFilter(ctx.user), { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
        db.collection("trips").find({}, { projection: { _id: 0, code: 1, routeName: 1, departureAt: 1, branchId: 1 } }).toArray(),
        db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray(),
      ]);
      const tripDetails = new Map(trips.map(trip => [String(trip.code), trip]));
      const branchNames = new Map(branches.map(branch => [Number(branch.id), String(branch.name)]));
      return reservations.map(reservation => {
        const trip = tripDetails.get(String(reservation.tripCode));
        const rawBranchId = reservation.branchId ?? trip?.branchId;
        const branchId = Number.isFinite(Number(rawBranchId)) ? Number(rawBranchId) : null;
        const branchName = branchId === null ? "غير مرتبط بفرع" : branchNames.get(branchId) ?? "فرع غير معروف";
        return {
          reservationCode: String(reservation.reservationCode),
          tripCode: String(reservation.tripCode),
          passengerName: String(reservation.passengerName),
          phone: String(reservation.phone),
          seatNumber: Number(reservation.seatNumber),
          ticketPrice: Number(reservation.ticketPrice),
          driverCommission: Number(reservation.driverCommission),
          officeRevenue: Number(reservation.officeRevenue),
          paymentMethod: String(reservation.paymentMethod),
          createdAt: reservation.createdAt as Date,
          branchId,
          branchName,
          trip: trip ? { code: String(trip.code), routeName: String(trip.routeName), departureAt: trip.departureAt as Date, branchId: trip.branchId ? Number(trip.branchId) : null, branchName: trip.branchId ? branchNames.get(Number(trip.branchId)) ?? "فرع غير معروف" : "غير مرتبط بفرع" } : null,
        };
      });
    }),
    listByTrip: protectedProcedure.input(z.object({ tripCode: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode, ...tripAccessFilter(ctx.user) }, { projection: { _id: 1 } });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة أو لا تملك صلاحية الوصول إليها." });
      return db.collection("reservations").find({ tripCode: input.tripCode, ...branchFilter(ctx.user) }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    }),
    create: protectedProcedure.input(mongoReservationSchema).mutation(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "bookings");
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة." });
      if (!canAccessTrip(ctx.user, trip)) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك الحجز إلا على رحلة فرعك أو الرحلة المشتركة مع فرعك." });
      if (trip.status !== "open" && trip.status !== "boarding") throw new TRPCError({ code: "BAD_REQUEST", message: "هذه الرحلة غير متاحة للحجز." });
      if (input.seatNumber > Number(trip.capacity)) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم المقعد يتجاوز سعة الحافلة." });
      const financials = calculateOfficeRevenue(input.ticketPrice, input.driverCommission);
      if (!financials.valid) throw new TRPCError({ code: "BAD_REQUEST", message: financials.message });
      const reservationCode = `SH-${Date.now().toString().slice(-8)}-${randomBytes(3).toString("hex")}`;
      const scopedBranch = branchFilter(ctx.user);
      const defaultBranchId = Number(trip.branchId) || undefined;
      const branchId = isSystemAdmin(ctx.user) ? input.branchId ?? defaultBranchId : scopedBranch.branchId;
      if (branchId && Number(branchId) !== Number(trip.branchId) && Number(branchId) !== Number(trip.sharedBranchId)) throw new TRPCError({ code: "FORBIDDEN", message: "يجب تسجيل الحجز على فرع الرحلة الأساسي أو الفرع المشارك فقط." });
      const branchDetails = await branchMessageDetails(db, branchId);
      const claimedTrip = await claimTripSeat(db, input.tripCode, input.seatNumber);
      if (!claimedTrip) throw new TRPCError({ code: "CONFLICT", message: "تم حجز هذا المقعد بواسطة مستخدم آخر للتو. تم تحديث الخريطة تلقائياً." });
      try {
        await db.collection("reservations").insertOne({ ...input, branchId, ...branchDetails, reservationCode, officeRevenue: financials.officeRevenue, createdByUserId: ctx.user.id, createdAt: new Date(), updatedAt: new Date() });
      } catch (error) {
        await db.collection("trips").updateOne({ code: input.tripCode }, { $pull: { bookedSeats: input.seatNumber }, $set: { updatedAt: new Date() } } as any);
        throw error;
      }
      const tripMessage = buildBookingMessage({ ...input, reservationCode, ...branchDetails, routeName: String(trip.routeName ?? ""), departureAt: trip.departureAt }, "reservation");
      void sendWasenderText({ to: input.phone, text: tripMessage, bookingType: "reservation", bookingCode: reservationCode, mode: "automatic", createdByUserId: ctx.user.id });
      return { reservationCode, officeRevenue: financials.officeRevenue, whatsappStatus: "queued" as const };
    }),
    update: protectedProcedure.input(mongoReservationUpdateSchema).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const scope = { reservationCode: input.reservationCode, ...branchFilter(ctx.user) };
      const reservation = await db.collection("reservations").findOne(scope);
      if (!reservation) throw new TRPCError({ code: "NOT_FOUND", message: "التذكرة غير موجودة أو لا تملك صلاحية تعديلها." });
      const nextDriverCommission = input.driverCommission ?? Number(reservation.driverCommission ?? 0);
      if (Number(reservation.ticketPrice) !== input.ticketPrice || Number(reservation.driverCommission ?? 0) !== nextDriverCommission) requireBranchPermission(ctx.user, "edit_prices");
      const trip = await db.collection("trips").findOne({ code: reservation.tripCode });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "رحلة التذكرة غير موجودة." });
      if (input.seatNumber > Number(trip.capacity)) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم المقعد يتجاوز سعة الحافلة." });
      const previousSeat = Number(reservation.seatNumber);
      const financials = calculateOfficeRevenue(input.ticketPrice, nextDriverCommission);
      if (!financials.valid) throw new TRPCError({ code: "BAD_REQUEST", message: financials.message });
      if (input.seatNumber !== previousSeat) {
        const claimedTrip = await claimTripSeat(db, String(reservation.tripCode), input.seatNumber);
        if (!claimedTrip) throw new TRPCError({ code: "CONFLICT", message: "تم حجز المقعد الجديد بواسطة مستخدم آخر للتو. تم تحديث الخريطة تلقائياً." });
        try {
          const result = await db.collection("reservations").updateOne(scope, { $set: { ...input, driverCommission: nextDriverCommission, officeRevenue: financials.officeRevenue, updatedAt: new Date(), updatedByUserId: ctx.user.id } });
          if (!result.matchedCount) throw new TRPCError({ code: "NOT_FOUND", message: "التذكرة غير موجودة أو لا تملك صلاحية تعديلها." });
          await db.collection("trips").updateOne({ code: String(reservation.tripCode) }, { $pull: { bookedSeats: previousSeat }, $set: { updatedAt: new Date() } } as any);
          return { reservationCode: input.reservationCode, officeRevenue: financials.officeRevenue };
        } catch (error) {
          await db.collection("trips").updateOne({ code: String(reservation.tripCode) }, { $pull: { bookedSeats: input.seatNumber }, $set: { updatedAt: new Date() } } as any);
          throw error;
        }
      }
      await db.collection("reservations").updateOne(scope, { $set: { ...input, driverCommission: nextDriverCommission, officeRevenue: financials.officeRevenue, updatedAt: new Date(), updatedByUserId: ctx.user.id } });
      return { reservationCode: input.reservationCode, officeRevenue: financials.officeRevenue };
    }),
    cancel: protectedProcedure.input(z.object({ reservationCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const reservationScope = { reservationCode: input.reservationCode, ...branchFilter(ctx.user) };
      const reservation = await db.collection("reservations").findOne(reservationScope);
      if (!reservation) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود أو أُلغي مسبقاً." });
      await db.collection("reservations").deleteOne(reservationScope);
      await db.collection("trips").updateOne(
        { code: reservation.tripCode },
        { $pull: { bookedSeats: reservation.seatNumber }, $set: { updatedAt: new Date() } },
      );
      return { reservationCode: input.reservationCode, seatNumber: reservation.seatNumber, tripCode: reservation.tripCode };
    }),
  }),
  externalBookings: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await getMongoDb();
      return db.collection("externalBookings").find(branchFilter(ctx.user), { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    }),
    create: protectedProcedure.input(externalBookingInputSchema).mutation(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "bookings");
      const db = await getMongoDb();
      const financials = calculateExternalOfficeRevenue(input.ticketPrice, input.externalOfficeFee);
      if (!financials.valid) throw new TRPCError({ code: "BAD_REQUEST", message: financials.message });
      const externalBookingCode = `EXB-${Date.now().toString().slice(-8)}`;
      const scopedBranch = branchFilter(ctx.user);
      const branchId = ctx.user.role === "admin" ? input.branchId : scopedBranch.branchId;
      const branchDetails = await branchMessageDetails(db, branchId);
      await db.collection("externalBookings").insertOne({ ...input, branchId, ...branchDetails, externalBookingCode, officeRevenue: financials.officeRevenue, createdByUserId: ctx.user.id, createdAt: new Date() });
      const externalMessage = buildBookingMessage({ ...input, externalBookingCode, ...branchDetails }, "external");
      void sendWasenderText({ to: input.phone, text: externalMessage, bookingType: "external", bookingCode: externalBookingCode, mode: "automatic", createdByUserId: ctx.user.id });
      return { externalBookingCode, officeRevenue: financials.officeRevenue, whatsappStatus: "queued" as const };
    }),
  }),
  customers: router({
    frequent: protectedProcedure.input(z.object({ search: z.string().trim().max(80).optional() }).optional()).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const query = input?.search?.trim();
      const textMatch = query ? { $or: [{ phone: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { passengerName: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] } : {};
      const scope = branchFilter(ctx.user);
      const [reservations, externalBookings] = await Promise.all([
        db.collection("reservations").find({ ...scope, ...textMatch }, { projection: { _id: 0, passengerName: 1, phone: 1, nationality: 1, passportNumber: 1, birthDate: 1, luggageCount: 1, passengerType: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(250).toArray(),
        db.collection("externalBookings").find({ ...scope, ...textMatch }, { projection: { _id: 0, passengerName: 1, phone: 1, nationality: 1, passportNumber: 1, birthDate: 1, luggageCount: 1, passengerType: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(250).toArray(),
      ]);
      const customers = new Map<string, Record<string, any>>();
      for (const item of [...reservations, ...externalBookings]) {
        const phone = String(item.phone ?? "").trim(); if (!phone) continue;
        const current = customers.get(phone);
        if (current) { current.bookingCount += 1; continue; }
        customers.set(phone, { phone, passengerName: String(item.passengerName ?? ""), nationality: String(item.nationality ?? ""), passportNumber: String(item.passportNumber ?? ""), birthDate: item.birthDate ? String(item.birthDate) : "", luggageCount: Number(item.luggageCount ?? 0), passengerType: String(item.passengerType ?? "بالغ"), bookingCount: 1, lastBookedAt: item.createdAt ?? null });
      }
      return Array.from(customers.values()).sort((a, b) => b.bookingCount - a.bookingCount || String(b.lastBookedAt ?? "").localeCompare(String(a.lastBookedAt ?? ""))).slice(0, 50);
    }),
  }),
  expenses: router({
    list: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional() }).optional()).query(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "cashbox");
      const db = await getMongoDb();
      const dateMatch = input?.from || input?.to ? { createdAt: { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}) } } : {};
      const forcedBranchId = ctx.user.role === "admin" ? input?.branchId : ctx.user.branchId;
      const branchMatch = forcedBranchId ? { branchId: forcedBranchId } : {};
      return db.collection("expenses").find({ ...dateMatch, ...branchMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    }),
    create: protectedProcedure.input(expenseInputSchema).mutation(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "cashbox");
      const db = await getMongoDb();
      const branchId = ctx.user.role === "admin" ? input.branchId : ctx.user.branchId;
      if (ctx.user.role !== "admin" && !branchId) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الفرع غير مرتبط بفرع تشغيلي." });
      const scopedInput = { ...input, ...(branchId ? { branchId } : {}) };
      await assertSufficientPaymentBalance(db, scopedInput, "المصروف");
      const expenseCode = `EX-${Date.now().toString().slice(-8)}`;
      await db.collection("expenses").insertOne({ ...scopedInput, expenseCode, createdByUserId: ctx.user.id, createdAt: new Date() });
      return { expenseCode };
    }),
  }),
  trusts: router({
    listByTrip: protectedProcedure.input(z.object({ tripCode: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode, ...tripAccessFilter(ctx.user) }, { projection: { _id: 1 } });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة أو لا تملك صلاحية الوصول إليها." });
      return db.collection("trusts").find({ tripCode: input.tripCode, ...branchFilter(ctx.user) }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    }),
    create: protectedProcedure.input(trustInputSchema).mutation(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "bookings");
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة." });
      if (!canAccessTrip(ctx.user, trip)) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إضافة أمانة إلا إلى رحلة فرعك أو الرحلة المشتركة مع فرعك." });
      const financials = calculateOfficeRevenue(input.fee, input.driverCommission);
      if (!financials.valid) throw new TRPCError({ code: "BAD_REQUEST", message: financials.message });
      const trustCode = `TR-${Date.now().toString().slice(-8)}`;
      const scopedBranch = branchFilter(ctx.user);
      const branchId = isSystemAdmin(ctx.user) ? (Number(trip.branchId) || undefined) : scopedBranch.branchId;
      const branchDetails = await branchMessageDetails(db, branchId);
      const trust = { ...input, price: input.fee, officeRevenue: financials.officeRevenue, branchId, ...branchDetails, trustCode, status: "pending", createdByUserId: ctx.user.id, createdAt: new Date() };
      await db.collection("trusts").insertOne(trust);
      const text = buildBookingMessage({ ...trust, routeName: trip.routeName, departureAt: trip.departureAt }, "trust");
      void sendWasenderText({ to: String(input.recipientPhone), text, bookingType: "trust", bookingCode: trustCode, mode: "automatic", createdByUserId: ctx.user.id });
      return { trustCode, officeRevenue: financials.officeRevenue };
    }),
    markDelivered: protectedProcedure.input(z.object({ trustCode: z.string().min(4) })).mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const result = await db.collection("trusts").updateOne({ trustCode: input.trustCode, ...branchFilter(ctx.user) }, { $set: { status: "delivered", deliveredAt: new Date() } });
      if (!result.matchedCount) throw new TRPCError({ code: "NOT_FOUND", message: "الأمانة غير موجودة." });
      return { trustCode: input.trustCode, status: "delivered" as const };
    }),
  }),
  reports: router({
    overview: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional(), tripCode: z.string().min(4).optional() }).optional()).query(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "reports");
      const db = await getMongoDb();
      const scope = ctx.user.role === "admin" ? input : { ...input, branchId: ctx.user.branchId ?? undefined };
      const { reservations, externalBookings, trusts, expenses, vouchers, ...overview } = await financialSummary(db, scope);
      return overview;
    }),
    branchComparison: adminProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional() }).optional()).query(async ({ input }) => {
      const db = await getMongoDb();
      const summary = await financialSummary(db, input);
      const tripBranchIds = new Map(summary.branchOperations.map(item => [String(item.branchId), item]));
      const rows = new Map(summary.branchBalances.map(item => [Number(item.branchId), { branchId: Number(item.branchId), branchName: String(item.branchName), tripCount: tripBranchIds.get(String(item.branchId))?.tripCount ?? 0, bookingCount: 0, ticketRevenue: 0, externalOfficeRevenue: 0, trustRevenue: 0, expensesTotal: 0, cashReceiptTotal: 0 }]));
      const rowFor = (branchId: unknown) => rows.get(Number(branchId));
      summary.reservations.forEach(item => { const row = rowFor(item.branchId); if (row) { row.bookingCount += 1; row.ticketRevenue += Number(item.ticketPrice ?? 0); } });
      summary.externalBookings.forEach(item => { const row = rowFor(item.branchId); if (row) row.externalOfficeRevenue += Number(item.officeRevenue ?? 0); });
      summary.trusts.forEach(item => { const row = rowFor(item.branchId); if (row) row.trustRevenue += Number(item.officeRevenue ?? (Number(item.fee ?? item.price ?? 0) - Number(item.driverCommission ?? 0))); });
      summary.expenses.forEach(item => { const row = rowFor(item.branchId); if (row) row.expensesTotal += Number(item.amount ?? 0); });
      summary.vouchers.forEach(item => { const row = rowFor(item.branchId); if (!row) return; if (item.type === "receipt") row.cashReceiptTotal += Number(item.amount ?? 0); else row.expensesTotal += Number(item.amount ?? 0); });
      return Array.from(rows.values()).sort((a, b) => a.branchName.localeCompare(b.branchName, "ar")).map(row => ({ ...row, totalBalance: row.ticketRevenue - summary.reservations.filter(item => Number(item.branchId) === row.branchId).reduce((sum, item) => sum + Number(item.driverCommission ?? 0), 0) + row.externalOfficeRevenue + row.trustRevenue + row.cashReceiptTotal - row.expensesTotal }));
    }),
    driverBusPerformance: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional(), tripCode: z.string().min(4).optional() }).optional()).query(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "reports");
      const db = await getMongoDb();
      const scopedInput = ctx.user.role === "admin" && !ctx.user.branchId ? input : { ...input, branchId: ctx.user.branchId ?? undefined };
      const departureMatch = scopedInput?.from || scopedInput?.to ? { departureAt: { ...(scopedInput?.from ? { $gte: new Date(scopedInput.from) } : {}), ...(scopedInput?.to ? { $lte: new Date(`${scopedInput.to}T23:59:59.999Z`) } : {}) } } : {};
      const tripFilter = { ...departureMatch, ...(scopedInput?.branchId ? { branchId: scopedInput.branchId } : {}), ...(scopedInput?.tripCode ? { code: scopedInput.tripCode } : {}) };
      const [trips, branches] = await Promise.all([
        db.collection("trips").find(tripFilter, { projection: { _id: 0, code: 1, bus: 1, busNumber: 1, driver: 1, primaryDriverName: 1, secondDriver: 1, secondDriverName: 1, capacity: 1, bookedSeats: 1, branchId: 1 } }).toArray(),
        db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray(),
      ]);
      const tripCodes = trips.map(trip => String(trip.code));
      const [reservations, trusts] = tripCodes.length ? await Promise.all([
        db.collection("reservations").find({ tripCode: { $in: tripCodes } }, { projection: { _id: 0, tripCode: 1, ticketPrice: 1, officeRevenue: 1, driverCommission: 1 } }).toArray(),
        db.collection("trusts").find({ tripCode: { $in: tripCodes } }, { projection: { _id: 0, tripCode: 1, driverCommission: 1 } }).toArray(),
      ]) : [[], []] as const;
      const branchNames = new Map(branches.map(branch => [Number(branch.id), String(branch.name)]));
      const byTrip = new Map<string, { booked: number; ticketRevenue: number; officeRevenue: number; driverCommission: number }>();
      for (const reservation of reservations) {
        const key = String(reservation.tripCode);
        const row = byTrip.get(key) ?? { booked: 0, ticketRevenue: 0, officeRevenue: 0, driverCommission: 0 };
        row.booked += 1; row.ticketRevenue += Number(reservation.ticketPrice ?? 0); row.officeRevenue += Number(reservation.officeRevenue ?? 0); row.driverCommission += Number(reservation.driverCommission ?? 0);
        byTrip.set(key, row);
      }
      for (const trust of trusts) {
        const key = String(trust.tripCode);
        const row = byTrip.get(key) ?? { booked: 0, ticketRevenue: 0, officeRevenue: 0, driverCommission: 0 };
        row.driverCommission += Number(trust.driverCommission ?? 0);
        byTrip.set(key, row);
      }
      type PerformanceRow = { name: string; branchName: string; tripCount: number; primaryTrips: number; assistantTrips: number; bookedSeats: number; capacity: number; ticketRevenue: number; officeRevenue: number; driverCommission: number };
      const drivers = new Map<string, PerformanceRow>(); const buses = new Map<string, PerformanceRow>();
      const append = (target: Map<string, PerformanceRow>, rawName: unknown, trip: Record<string, any>, summary: { booked: number; ticketRevenue: number; officeRevenue: number; driverCommission: number }, role: "primary" | "assistant" | "bus") => {
        const name = String(rawName ?? "").trim() || "غير محدد";
        const current = target.get(name) ?? { name, branchName: branchNames.get(Number(trip.branchId)) ?? "غير مرتبط بفرع", tripCount: 0, primaryTrips: 0, assistantTrips: 0, bookedSeats: 0, capacity: 0, ticketRevenue: 0, officeRevenue: 0, driverCommission: 0 };
        current.tripCount += 1; if (role === "primary") current.primaryTrips += 1; if (role === "assistant") current.assistantTrips += 1;
        current.bookedSeats += summary.booked; current.capacity += Number(trip.capacity ?? 0); current.ticketRevenue += summary.ticketRevenue; current.officeRevenue += summary.officeRevenue; current.driverCommission += summary.driverCommission;
        target.set(name, current);
      };
      for (const trip of trips) {
        const summary = byTrip.get(String(trip.code)) ?? { booked: Array.isArray(trip.bookedSeats) ? trip.bookedSeats.length : 0, ticketRevenue: 0, officeRevenue: 0, driverCommission: 0 };
        const primaryDriver = trip.primaryDriverName ?? trip.driver;
        const assistantDriver = trip.secondDriverName ?? trip.secondDriver;
        append(drivers, primaryDriver, trip, summary, "primary");
        if (String(assistantDriver ?? "").trim() && String(assistantDriver) !== String(primaryDriver)) append(drivers, assistantDriver, trip, summary, "assistant");
        append(buses, trip.busNumber ?? trip.bus, trip, summary, "bus");
      }
      const present = (items: Map<string, PerformanceRow>) => Array.from(items.values()).map(row => ({ ...row, occupancyRate: row.capacity ? Math.round((row.bookedSeats / row.capacity) * 100) : 0 })).sort((a, b) => b.officeRevenue - a.officeRevenue || b.tripCount - a.tripCount || a.name.localeCompare(b.name, "ar"));
      return { drivers: present(drivers), buses: present(buses) };
    }),
    serviceQuality: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional(), tripCode: z.string().min(4).optional() }).optional()).query(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "reports");
      const db = await getMongoDb();
      const scopedInput = ctx.user.role === "admin" && !ctx.user.branchId ? input : { ...input, branchId: ctx.user.branchId ?? undefined };
      const dateMatch = scopedInput?.from || scopedInput?.to ? { createdAt: { ...(scopedInput?.from ? { $gte: new Date(scopedInput.from) } : {}), ...(scopedInput?.to ? { $lte: new Date(`${scopedInput.to}T23:59:59.999Z`) } : {}) } } : {};
      const feedback = await db.collection("customerFeedback").find(dateMatch, { projection: { _id: 0 } }).toArray();
      const codes = feedback.map(item => String(item.bookingCode ?? "")).filter(Boolean);
      const [reservations, branches] = await Promise.all([
        codes.length ? db.collection("reservations").find({ reservationCode: { $in: codes } }, { projection: { _id: 0, reservationCode: 1, tripCode: 1, branchId: 1 } }).toArray() : Promise.resolve([]),
        db.collection("branches").find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray(),
      ]);
      const bookingMap = new Map(reservations.map(item => [String(item.reservationCode), item])); const branchNames = new Map(branches.map(branch => [Number(branch.id), String(branch.name)]));
      type QualityRow = { key: string; label: string; positive: number; issues: number; responses: number };
      const branchRows = new Map<string, QualityRow>(); const tripRows = new Map<string, QualityRow>();
      const add = (target: Map<string, QualityRow>, key: string, label: string, positive: boolean) => { const row = target.get(key) ?? { key, label, positive: 0, issues: 0, responses: 0 }; row.responses += 1; if (positive) row.positive += 1; else row.issues += 1; target.set(key, row); };
      for (const item of feedback) {
        const booking = bookingMap.get(String(item.bookingCode ?? "")); if (!booking) continue;
        if (scopedInput?.branchId && Number(booking.branchId) !== scopedInput.branchId) continue;
        if (scopedInput?.tripCode && String(booking.tripCode) !== scopedInput.tripCode) continue;
        const positive = String(item.rating) === "positive"; const branchId = Number(booking.branchId);
        add(branchRows, String(branchId || "unassigned"), branchNames.get(branchId) ?? "غير مرتبط بفرع", positive); add(tripRows, String(booking.tripCode), String(booking.tripCode), positive);
      }
      const present = (rows: Map<string, QualityRow>) => Array.from(rows.values()).map(row => ({ ...row, satisfactionRate: row.responses ? Math.round((row.positive / row.responses) * 100) : 0 })).sort((a, b) => b.responses - a.responses || a.label.localeCompare(b.label, "ar"));
      const branchData = present(branchRows); const tripData = present(tripRows); const positive = branchData.reduce((sum, row) => sum + row.positive, 0); const issues = branchData.reduce((sum, row) => sum + row.issues, 0); const responses = positive + issues;
      return { positive, issues, responses, satisfactionRate: responses ? Math.round((positive / responses) * 100) : 0, branches: branchData, trips: tripData };
    }),
    tripRevenue: protectedProcedure.input(z.object({ tripCode: z.string().min(4) })).query(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const trip = await db.collection("trips").findOne({ code: input.tripCode, ...tripAccessFilter(ctx.user) }, { projection: { _id: 1 } });
      if (!trip) throw new TRPCError({ code: "NOT_FOUND", message: "الرحلة غير موجودة أو لا تملك صلاحية الوصول إليها." });
      const scope = branchFilter(ctx.user);
      const [ticketSummary] = await db.collection("reservations").aggregate([
        { $match: { tripCode: input.tripCode, ...scope } },
        { $group: { _id: "$tripCode", ticketCount: { $sum: 1 }, totalTicketSales: { $sum: "$ticketPrice" }, totalDriverCommission: { $sum: "$driverCommission" }, officeRevenue: { $sum: "$officeRevenue" } } },
      ]).toArray();
      const [trustSummary] = await db.collection("trusts").aggregate([
        { $match: { tripCode: input.tripCode, ...scope } },
        { $group: { _id: "$tripCode", trustCount: { $sum: 1 }, totalTrustFees: { $sum: { $ifNull: ["$fee", "$price"] } }, totalTrustDriverCommission: { $sum: { $ifNull: ["$driverCommission", 0] } }, trustOfficeRevenue: { $sum: { $ifNull: ["$officeRevenue", { $subtract: [{ $ifNull: ["$fee", "$price"] }, { $ifNull: ["$driverCommission", 0] }] }] } } } },
      ]).toArray();
      const totalTicketSales = Number(ticketSummary?.totalTicketSales ?? 0);
      const totalTrustFees = Number(trustSummary?.totalTrustFees ?? 0);
      const totalTrustRevenue = Number(trustSummary?.trustOfficeRevenue ?? 0);
      return {
        tripCode: input.tripCode,
        ticketCount: Number(ticketSummary?.ticketCount ?? 0),
        trustCount: Number(trustSummary?.trustCount ?? 0),
        totalTicketSales,
        totalTrustFees,
        totalTrustRevenue,
        totalTrustDriverCommission: Number(trustSummary?.totalTrustDriverCommission ?? 0),
        totalDriverCommission: Number(ticketSummary?.totalDriverCommission ?? 0),
        officeRevenue: Number(ticketSummary?.officeRevenue ?? 0) + totalTrustRevenue,
        totalGrossRevenue: totalTicketSales + totalTrustFees,
      };
    }),
  }),
  cashbox: router({
    vouchers: router({
      list: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional() }).optional()).query(async ({ ctx, input }) => {
        requireBranchPermission(ctx.user, "cashbox");
        const db = await getMongoDb();
        const dateMatch = input?.from || input?.to ? { createdAt: { ...(input.from ? { $gte: new Date(input.from) } : {}), ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}) } } : {};
        const isAdmin = ctx.user.role === "admin" && !ctx.user.branchId;
        const forcedBranchId = isAdmin ? input?.branchId : ctx.user.branchId;
        const branchMatch = forcedBranchId ? { branchId: forcedBranchId } : {};
        return db.collection("cashVouchers").find({ ...dateMatch, ...branchMatch }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
      }),
      create: protectedProcedure.input(cashVoucherInputSchema).mutation(async ({ ctx, input }) => {
        requireBranchPermission(ctx.user, "cashbox");
        const db = await getMongoDb();
        const isAdmin = ctx.user.role === "admin" && !ctx.user.branchId;
        const branchId = isAdmin ? input.branchId : ctx.user.branchId;
        if (!isAdmin && !branchId) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الفرع غير مرتبط بفرع تشغيلي." });
        const scopedInput = { ...input, ...(branchId ? { branchId } : {}) };
        if (scopedInput.type === "payment") await assertSufficientPaymentBalance(db, scopedInput, "سند الصرف");
        const voucherCode = `${input.type === "receipt" ? "RV" : "PV"}-${Date.now().toString().slice(-8)}`;
        await db.collection("cashVouchers").insertOne({ ...scopedInput, voucherCode, createdByUserId: ctx.user.id, createdAt: new Date() });
        return { voucherCode };
      }),
    }),
    overview: protectedProcedure.input(z.object({ from: z.string().optional(), to: z.string().optional(), branchId: z.number().int().positive().optional() }).optional()).query(async ({ ctx, input }) => {
      requireBranchPermission(ctx.user, "cashbox");
      const db = await getMongoDb();
        const isAdmin = ctx.user.role === "admin" && !ctx.user.branchId;
        const forcedBranchId = isAdmin ? input?.branchId : ctx.user.branchId;
        if (!isAdmin && !forcedBranchId) throw new TRPCError({ code: "FORBIDDEN", message: "حساب الفرع غير مرتبط بفرع تشغيلي." });
      const summary = await financialSummary(db, { ...input, ...(forcedBranchId ? { branchId: forcedBranchId } : {}) });
      const transactions = [
        ...summary.reservations.map(item => ({ id: String(item.reservationCode), kind: "حجز", description: `تذكرة ${item.passengerName} · ${item.tripCode}`, amount: Number(item.officeRevenue ?? 0), paymentMethod: normalizePaymentMethod(item.paymentMethod), createdAt: item.createdAt, tone: "income" as const })),
        ...summary.externalBookings.map(item => ({ id: String(item.externalBookingCode), kind: "حجز خارجي", description: `تذكرة ${item.passengerName} · ${item.externalOfficeName} · ${item.routeName}`, amount: Number(item.officeRevenue ?? 0), paymentMethod: normalizePaymentMethod(item.paymentMethod), createdAt: item.createdAt, tone: "income" as const })),
        ...summary.trusts.map(item => ({ id: String(item.trustCode), kind: "أمانة", description: `${item.itemDescription} · ${item.tripCode}`, amount: Number(item.officeRevenue ?? (Number(item.fee ?? item.price ?? 0) - Number(item.driverCommission ?? 0))), paymentMethod: normalizePaymentMethod(item.paymentMethod), createdAt: item.createdAt, tone: "trust" as const })),
        ...summary.expenses.map(item => ({ id: String(item.expenseCode), kind: "مصروف", description: `${item.category} · ${item.description}`, amount: -Number(item.amount ?? 0), paymentMethod: normalizePaymentMethod(item.paymentMethod), createdAt: item.createdAt, tone: "expense" as const })),
        ...summary.vouchers.map(item => ({ id: String(item.voucherCode), kind: item.type === "receipt" ? "سند قبض" : "سند صرف", description: `${item.partyName} · ${item.category} · ${item.description}`, amount: item.type === "receipt" ? Number(item.amount ?? 0) : -Number(item.amount ?? 0), paymentMethod: normalizePaymentMethod(item.paymentMethod), createdAt: item.createdAt, tone: item.type === "receipt" ? "income" as const : "expense" as const })),
      ].sort((a, b) => new Date(b.createdAt as Date).valueOf() - new Date(a.createdAt as Date).valueOf());
      return { ...summary, transactions };
    }),
  }),
});
