import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const suffix = `IT${Date.now().toString().slice(-8)}`;
const tripCode = `TEST-${suffix}`;
const branchTripCode = `BRANCH-${suffix}`;
const reservationCodePattern = /^SH-/;
const branchUserEmail = `branch-${suffix.toLowerCase()}@example.test`;
const branchName = `فرع اختبار ${suffix}`;
const sharedBranchUserEmail = `shared-branch-${suffix.toLowerCase()}@example.test`;
const sharedBranchName = `فرع شريك ${suffix}`;
const externalRouteName = `مسار خارجي ${suffix}`;
let client: MongoClient;

const ctx = {
  user: {
    id: 99001,
    openId: "mongo-integration-test",
    name: "اختبار MongoDB",
    email: "test@example.com",
    loginMethod: "manus",
    role: "admin",
    branchId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  },
  req: {} as TrpcContext["req"],
  res: {} as TrpcContext["res"],
} as TrpcContext;

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
}, 30_000);

afterAll(async () => {
  const db = client.db("sahood_bus_booking");
  await Promise.all([
    db.collection("reservations").deleteMany({ tripCode: { $in: [tripCode, branchTripCode] } }),
    db.collection("externalBookings").deleteMany({ routeName: externalRouteName }),
    db.collection("trusts").deleteMany({ tripCode: { $in: [tripCode, branchTripCode] } }),
    db.collection("trips").deleteMany({ code: { $in: [tripCode, branchTripCode] } }),
    db.collection("localUsers").deleteMany({ email: branchUserEmail }),
    db.collection("branches").deleteMany({ name: branchName }),
    db.collection("localUsers").deleteMany({ email: sharedBranchUserEmail }),
    db.collection("branches").deleteMany({ name: sharedBranchName }),
    db.collection("expenses").deleteMany({ description: `مصروف اختبار ${suffix}` }),
    db.collection("cashVouchers").deleteMany({ description: { $in: [`سند قبض اختبار ${suffix}`, `سند صرف اختبار ${suffix}`] } }),
  ]);
  await client.close();
}, 120_000);

describe("تكامل رحلة وحجز وأمانة في MongoDB", () => {
  it("يحفظ البيانات ويحسب التقرير ويلغي الحجز مع تحرير المقعد", async () => {
    const caller = appRouter.createCaller(ctx);
    await caller.mongoBooking.trips.create({
      code: tripCode,
      routeName: "اختبار الرياض ← المدينة",
      busNumber: "TEST-01",
      primaryDriverName: "سائق الاختبار",
      secondDriverName: "مساعد الاختبار",
      departureDate: "2026-09-01",
      departureTime: "08:30",
      capacity: 25,
      status: "open",
    });

    const createdReservation = await caller.mongoBooking.reservations.create({
      tripCode,
      seatNumber: 5,
      passengerName: "مسافر اختبار",
      phone: "0500000000",
      nationality: "سعودي",
      passportNumber: "TEST-123",
      birthDate: "1990-01-01",
      luggageCount: 1,
      passengerType: "بالغ",
      paymentMethod: "نقدي",
      ticketPrice: 100,
      driverCommission: 60,
    });
    expect(createdReservation.reservationCode).toMatch(reservationCodePattern);
    expect(createdReservation.officeRevenue).toBe(40);
    const driverManifest = await caller.mongoBooking.trips.driverManifest({ tripCode });
    expect(driverManifest).toMatchObject({ trip: { code: tripCode, busNumber: "TEST-01" } });
    expect(driverManifest.reservations).toEqual(expect.arrayContaining([expect.objectContaining({ reservationCode: createdReservation.reservationCode, seatNumber: 5, luggageCount: 1 })]));
    const performance = await caller.mongoBooking.reports.driverBusPerformance({ tripCode });
    expect(performance.drivers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "سائق الاختبار", tripCount: 1, bookedSeats: 1, officeRevenue: 40 })]));
    expect(performance.buses).toEqual(expect.arrayContaining([expect.objectContaining({ name: "TEST-01", tripCount: 1, occupancyRate: 4 })]));
    await expect(caller.mongoBooking.trips.start({ tripCode })).resolves.toMatchObject({ tripCode, status: "departed" });
    const frequentCustomers = await caller.mongoBooking.customers.frequent({ search: "0500000000" });
    expect(frequentCustomers).toEqual(expect.arrayContaining([expect.objectContaining({ phone: "0500000000", passengerName: "مسافر اختبار", bookingCount: 1 })]));

    const branchLocationUrl = `https://maps.google.com/?q=${encodeURIComponent(branchName)}`;
    const branchUser = await caller.mongoBooking.admin.users.create({ name: "مستخدم فرع اختبار", email: branchUserEmail, phone: "0551111111", password: "StrongPass123!", branchName, branchLocationUrl });
    const sharedBranchUser = await caller.mongoBooking.admin.users.create({ name: "مستخدم الفرع الشريك", email: sharedBranchUserEmail, phone: "0557777777", password: "StrongPass123!", branchName: sharedBranchName });
    const users = await caller.mongoBooking.admin.users.list();
    expect(users.some(user => user.email === branchUserEmail && user.phone === "0551111111" && user.isActive && user.branchName === branchName && user.branchLocationUrl === branchLocationUrl)).toBe(true);
    expect(branchUser.branchId).toBeTypeOf("number");
    await caller.mongoBooking.admin.users.update({ id: branchUser.id, name: "مستخدم فرع بعد التعديل", email: branchUserEmail, phone: "0552222222", branchId: branchUser.branchId });
    expect((await caller.mongoBooking.admin.users.list()).find(user => user.id === branchUser.id)).toMatchObject({ name: "مستخدم فرع بعد التعديل", phone: "0552222222", branchId: branchUser.branchId });
    await caller.mongoBooking.admin.users.update({ id: branchUser.id, name: "مستخدم فرع بعد التعديل", email: branchUserEmail, phone: "0552222222", branchId: branchUser.branchId, permissions: ["bookings"] });
    expect((await caller.mongoBooking.admin.users.list()).find(user => user.id === branchUser.id)?.permissions).toEqual(["bookings"]);
    const restrictedBranchCaller = appRouter.createCaller({ ...ctx, user: { ...ctx.user!, id: 99003, openId: "branch-restricted-test", role: "user", branchId: branchUser.branchId, permissions: ["bookings"] } });
    await expect(restrictedBranchCaller.mongoBooking.cashbox.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(restrictedBranchCaller.mongoBooking.reports.branchComparison()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const branchCaller = appRouter.createCaller({ ...ctx, user: { ...ctx.user!, id: 99002, openId: "branch-test", role: "user", branchId: branchUser.branchId } });
    const sharedBranchCaller = appRouter.createCaller({ ...ctx, user: { ...ctx.user!, id: 99004, openId: "shared-branch-test", role: "user", branchId: sharedBranchUser.branchId } });
    const branchOverview = await branchCaller.mongoBooking.reports.overview();
    expect(branchOverview).toMatchObject({ tripCount: 0, bookingCount: 0 });
    expect(branchOverview.branchBalances).toEqual(expect.arrayContaining([expect.objectContaining({ branchId: branchUser.branchId })]));
    await expect(branchCaller.auth.me()).resolves.toMatchObject({ role: "user", branchId: branchUser.branchId, branchName });
    await expect(branchCaller.mongoBooking.admin.users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await branchCaller.mongoBooking.trips.create({
      code: branchTripCode,
      routeName: "رحلة فرع اختبار",
      busNumber: "BR-01",
      primaryDriverName: "سائق فرع اختبار",
      departureDate: "2026-09-02",
      departureTime: "10:00",
      capacity: 20,
      status: "open",
      sharedBranchId: sharedBranchUser.branchId,
    });
    const branchTrips = await branchCaller.mongoBooking.trips.list();
    expect(branchTrips.map(trip => trip.code)).toEqual([branchTripCode]);
    expect(branchTrips[0]?.branchId).toBe(branchUser.branchId);
    expect(branchTrips[0]?.sharedBranchId).toBe(sharedBranchUser.branchId);
    await expect(sharedBranchCaller.mongoBooking.trips.list()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ code: branchTripCode, branchId: branchUser.branchId, sharedBranchId: sharedBranchUser.branchId })]));
    const concurrentReservation = { tripCode: branchTripCode, seatNumber: 1, passengerName: "راكب حجز متزامن", phone: "0577777777", nationality: "سعودي", passportNumber: "SEAT-RACE-1", luggageCount: 0, passengerType: "بالغ" as const, paymentMethod: "نقدي" as const, ticketPrice: 100, driverCommission: 20 };
    const [primaryAttempt, sharedAttempt] = await Promise.allSettled([
      branchCaller.mongoBooking.reservations.create(concurrentReservation),
      sharedBranchCaller.mongoBooking.reservations.create(concurrentReservation),
    ]);
    const successfulAttempt = [primaryAttempt, sharedAttempt].filter((result): result is PromiseFulfilledResult<{ reservationCode: string }> => result.status === "fulfilled");
    const rejectedAttempt = [primaryAttempt, sharedAttempt].filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(successfulAttempt).toHaveLength(1);
    expect(rejectedAttempt).toHaveLength(1);
    expect(rejectedAttempt[0]?.reason).toMatchObject({ code: "CONFLICT" });
    if (primaryAttempt.status === "fulfilled") await branchCaller.mongoBooking.reservations.cancel({ reservationCode: primaryAttempt.value.reservationCode });
    else await sharedBranchCaller.mongoBooking.reservations.cancel({ reservationCode: sharedAttempt.status === "fulfilled" ? sharedAttempt.value.reservationCode : "" });
    expect((await caller.mongoBooking.trips.list()).find(trip => trip.code === branchTripCode)?.bookedSeats).not.toContain(1);
    const reloadedBranchTrips = await branchCaller.mongoBooking.trips.list();
    expect(reloadedBranchTrips.map(trip => trip.code)).toEqual([branchTripCode]);

    const allReservations = await caller.mongoBooking.reservations.list();
    expect(allReservations.some(reservation => reservation.reservationCode === createdReservation.reservationCode)).toBe(true);

    const createdTrust = await caller.mongoBooking.trusts.create({
      tripCode,
      senderName: "مرسل اختبار",
      senderPhone: "0511111111",
      recipientName: "مستلم اختبار",
      recipientPhone: "0522222222",
      itemDescription: "حقيبة اختبار",
      itemCount: 1,
      fee: 25,
      driverCommission: 5,
    });
    await caller.mongoBooking.trusts.markDelivered({ trustCode: createdTrust.trustCode });
    const deliveredTrust = await client.db("sahood_bus_booking").collection("trusts").findOne({ trustCode: createdTrust.trustCode });
    expect(deliveredTrust?.status).toBe("delivered");
    expect(deliveredTrust).toMatchObject({ fee: 25, driverCommission: 5, officeRevenue: 20 });
    const manifestWithTrust = await caller.mongoBooking.trips.driverManifest({ tripCode });
    expect(manifestWithTrust.trusts).toEqual(expect.arrayContaining([expect.objectContaining({ trustCode: createdTrust.trustCode, senderName: "مرسل اختبار", recipientName: "مستلم اختبار", itemDescription: "حقيبة اختبار", status: "delivered" })]));

    await expect(branchCaller.mongoBooking.reservations.create({
      tripCode,
      seatNumber: 6,
      passengerName: "مسافر فرع اختبار",
      phone: "0533333333",
      nationality: "سعودي",
      passportNumber: "TEST-BRANCH-123",
      luggageCount: 0,
      passengerType: "بالغ",
      paymentMethod: "شبكة",
      ticketPrice: 120,
      driverCommission: 60,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const branchReservation = await branchCaller.mongoBooking.reservations.create({
      tripCode: branchTripCode,
      seatNumber: 6,
      passengerName: "مسافر فرع اختبار",
      phone: "0533333333",
      nationality: "سعودي",
      passportNumber: "TEST-BRANCH-123",
      luggageCount: 0,
      passengerType: "بالغ",
      paymentMethod: "شبكة",
      ticketPrice: 120,
      driverCommission: 60,
    });
    const branchReportAfterReservation = await branchCaller.mongoBooking.reports.overview();
    expect(branchReportAfterReservation).toMatchObject({ tripCount: 1, bookingCount: 1 });
    expect((await branchCaller.mongoBooking.reports.driverBusPerformance()).drivers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "سائق فرع اختبار", tripCount: 1 })]));
    expect((await branchCaller.mongoBooking.reservations.listByTrip({ tripCode: branchTripCode })).find(item => item.reservationCode === branchReservation.reservationCode)).toMatchObject({ branchContactPhone: "0552222222", branchName, branchLocationUrl });
    await expect(branchCaller.mongoBooking.reservations.update({ reservationCode: branchReservation.reservationCode, seatNumber: 6, passengerName: "مسافر فرع اختبار", phone: "0533333333", nationality: "سعودي", passportNumber: "TEST-BRANCH-123", luggageCount: 0, passengerType: "بالغ", paymentMethod: "شبكة", ticketPrice: 130, driverCommission: 60 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const branchExternalBooking = await branchCaller.mongoBooking.externalBookings.create({
      routeName: externalRouteName,
      travelDate: "2026-09-03",
      externalOfficeName: "المكتب الخارجي للاختبار",
      passengerName: "مسافر خارجي اختبار",
      phone: "0566666666",
      nationality: "سعودي",
      passportNumber: "EXTERNAL-TEST-123",
      luggageCount: 1,
      passengerType: "بالغ",
      paymentMethod: "شبكة",
      ticketPrice: 90,
      externalOfficeFee: 30,
    });
    expect(branchExternalBooking).toMatchObject({ officeRevenue: 60 });
    expect(branchExternalBooking.externalBookingCode).toMatch(/^EXB-/);
    const branchExternalBookings = await branchCaller.mongoBooking.externalBookings.list();
    expect(branchExternalBookings).toEqual(expect.arrayContaining([expect.objectContaining({ externalBookingCode: branchExternalBooking.externalBookingCode, branchId: branchUser.branchId, officeRevenue: 60 })]));
    const branchTrust = await branchCaller.mongoBooking.trusts.create({
      tripCode: branchTripCode,
      senderName: "مرسل فرع اختبار",
      senderPhone: "0544444444",
      recipientName: "مستلم فرع اختبار",
      recipientPhone: "0555555555",
      itemDescription: "أمانة فرع اختبار",
      itemCount: 1,
      fee: 10,
      driverCommission: 2,
      paymentMethod: "نقدي",
    });
    const branchReservations = await branchCaller.mongoBooking.reservations.listByTrip({ tripCode: branchTripCode });
    const branchTrusts = await branchCaller.mongoBooking.trusts.listByTrip({ tripCode: branchTripCode });
    expect(branchReservations.map(reservation => reservation.reservationCode)).toEqual([branchReservation.reservationCode]);
    expect(branchTrusts.map(trust => trust.trustCode)).toEqual([branchTrust.trustCode]);
    await expect(branchCaller.mongoBooking.reservations.cancel({ reservationCode: createdReservation.reservationCode })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const report = await caller.mongoBooking.reports.tripRevenue({ tripCode });
    expect(report).toMatchObject({ ticketCount: 1, trustCount: 1, totalTicketSales: 100, totalDriverCommission: 60, totalTrustFees: 25, totalTrustDriverCommission: 5, totalTrustRevenue: 20, officeRevenue: 60, totalGrossRevenue: 125 });
    await branchCaller.mongoBooking.expenses.create({ category: "تشغيل", description: `مصروف اختبار ${suffix}`, amount: 15, paymentMethod: "شبكة", branchId: 999 });
    const cashboxAfterExpense = await caller.mongoBooking.cashbox.overview({ branchId: branchUser.branchId! });
    expect(cashboxAfterExpense).toMatchObject({ bookingCount: 1, externalBookingCount: 1, trustCount: 1, ticketRevenue: 120, driverCommission: 60, officeRevenue: 60, externalBookingGross: 90, externalOfficeFee: 30, externalOfficeRevenue: 60, totalOfficeRevenue: 120, trustRevenue: 8, trustDriverCommission: 2, expensesTotal: 15, cashBalance: 8, networkBalance: 105, totalBalance: 113 });
    expect(cashboxAfterExpense.transactions).toEqual(expect.arrayContaining([expect.objectContaining({ id: branchExternalBooking.externalBookingCode, kind: "حجز خارجي", amount: 60 })]));
    await expect(caller.mongoBooking.expenses.create({ category: "تشغيل", description: `مصروف اختبار ${suffix}`, amount: 106, paymentMethod: "شبكة", branchId: branchUser.branchId! })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("رصيد شبكة المتاح") });
    expect((await caller.mongoBooking.cashbox.overview({ branchId: branchUser.branchId! })).networkBalance).toBe(105);
    const overview = await caller.mongoBooking.reports.overview();
    expect(overview).not.toHaveProperty("expenses");
    expect(overview.bookingCount).toBeGreaterThan(0);
    const branchExpenses = await caller.mongoBooking.expenses.list({ branchId: branchUser.branchId! });
    expect(branchExpenses.some(expense => expense.description === `مصروف اختبار ${suffix}`)).toBe(true);
    const scopedBranchExpenses = await branchCaller.mongoBooking.expenses.list({ branchId: 999 });
    expect(scopedBranchExpenses).toEqual(expect.arrayContaining([expect.objectContaining({ description: `مصروف اختبار ${suffix}`, branchId: branchUser.branchId })]));
    const scopedBranchCashbox = await branchCaller.mongoBooking.cashbox.overview({ branchId: 999 });
    expect(scopedBranchCashbox).toMatchObject({ cashBalance: 8, networkBalance: 105, totalBalance: 113 });
    const branchTripOverview = await caller.mongoBooking.reports.overview({ branchId: branchUser.branchId!, tripCode: branchTripCode });
    expect(branchTripOverview).toMatchObject({ bookingCount: 1, externalBookingCount: 0, trustCount: 1, ticketRevenue: 120, officeRevenue: 60, externalOfficeRevenue: 0, totalOfficeRevenue: 60, trustRevenue: 8, trustDriverCommission: 2, expensesTotal: 15, totalBalance: 53 });
    expect(branchTripOverview.branchOperations).toEqual(expect.arrayContaining([expect.objectContaining({ branchId: branchUser.branchId, branchName, tripCount: 1, bookingCount: 1 })]));
    const reloadedOperations = await caller.mongoBooking.reports.overview();
    expect(reloadedOperations.branchOperations).toEqual(expect.arrayContaining([expect.objectContaining({ branchId: branchUser.branchId, branchName, tripCount: 1, bookingCount: 1 })]));
    const branchComparison = await caller.mongoBooking.reports.branchComparison();
    expect(branchComparison).toEqual(expect.arrayContaining([expect.objectContaining({ branchId: branchUser.branchId, branchName, tripCount: 1, bookingCount: 1, ticketRevenue: 120, externalOfficeRevenue: 60, trustRevenue: 8, expensesTotal: 15, totalBalance: 113 })]));

    const receiptVoucher = await branchCaller.mongoBooking.cashbox.vouchers.create({ type: "receipt", partyName: "عميل اختبار", category: "تحصيل", description: `سند قبض اختبار ${suffix}`, amount: 30, paymentMethod: "شبكة" });
    await expect(branchCaller.mongoBooking.cashbox.vouchers.create({ type: "payment", partyName: "مورد اختبار", category: "عهدة", description: `سند صرف اختبار ${suffix}`, amount: 9, paymentMethod: "نقدي", branchId: 999 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("رصيد نقدي المتاح") });
    const paymentVoucher = await branchCaller.mongoBooking.cashbox.vouchers.create({ type: "payment", partyName: "مورد اختبار", category: "عهدة", description: `سند صرف اختبار ${suffix}`, amount: 8, paymentMethod: "نقدي", branchId: 999 });
    expect(receiptVoucher.voucherCode).toMatch(/^RV-/);
    expect(paymentVoucher.voucherCode).toMatch(/^PV-/);
    const filteredVouchers = await caller.mongoBooking.cashbox.vouchers.list({ branchId: branchUser.branchId! });
    expect(filteredVouchers.map(voucher => voucher.voucherCode)).toEqual(expect.arrayContaining([receiptVoucher.voucherCode, paymentVoucher.voucherCode]));
    const scopedBranchVouchers = await branchCaller.mongoBooking.cashbox.vouchers.list({ branchId: 999 });
    expect(scopedBranchVouchers.map(voucher => voucher.voucherCode)).toEqual(expect.arrayContaining([receiptVoucher.voucherCode, paymentVoucher.voucherCode]));
    const cashboxAfterVouchers = await caller.mongoBooking.cashbox.overview({ branchId: branchUser.branchId! });
    expect(cashboxAfterVouchers).toMatchObject({ cashReceiptTotal: 30, cashPaymentTotal: 8, externalOfficeRevenue: 60, totalOfficeRevenue: 120, trustRevenue: 8, trustDriverCommission: 2, expensesTotal: 15, cashBalance: 0, networkBalance: 135, totalBalance: 135 });
    expect(cashboxAfterVouchers.branchBalances).toEqual(expect.arrayContaining([expect.objectContaining({ branchId: branchUser.branchId, branchName, externalBookingCount: 1, externalOfficeRevenue: 60, totalOfficeRevenue: 120, trustRevenue: 8, trustDriverCommission: 2, cashBalance: 0, networkBalance: 135, cashReceiptTotal: 30, cashPaymentTotal: 8, expensesTotal: 15, totalBalance: 135 })]));
    const backup = await caller.mongoBooking.admin.exports.backup();
    expect(backup.users.find(user => user.id === branchUser.id)).toMatchObject({ name: "مستخدم فرع بعد التعديل", phone: "0552222222" });
    expect(backup.trips.some(item => item.code === branchTripCode)).toBe(true);
    expect(backup.externalBookings.some(item => item.externalBookingCode === branchExternalBooking.externalBookingCode)).toBe(true);
    expect(backup.cashVouchers.map(item => item.voucherCode)).toEqual(expect.arrayContaining([receiptVoucher.voucherCode, paymentVoucher.voucherCode]));

    const updatedBranchReservation = await branchCaller.mongoBooking.reservations.update({ reservationCode: branchReservation.reservationCode, passengerName: "مسافر فرع معدل", phone: "0553333333", nationality: "سعودي", passportNumber: "BR-UPDATED", birthDate: "1992-02-02", luggageCount: 2, passengerType: "بالغ", paymentMethod: "شبكة", seatNumber: 7, ticketPrice: 120 });
    expect(updatedBranchReservation.officeRevenue).toBe(60);
    expect((await branchCaller.mongoBooking.reservations.listByTrip({ tripCode: branchTripCode })).find(item => item.reservationCode === branchReservation.reservationCode)).toMatchObject({ passengerName: "مسافر فرع معدل", seatNumber: 7, driverCommission: 60, officeRevenue: 60 });
    expect((await client.db("sahood_bus_booking").collection("trips").findOne({ code: branchTripCode }))?.bookedSeats).toContain(7);
    const updatedLocationUrl = `https://maps.google.com/?q=${encodeURIComponent(`${branchName} الجديد`)}`;
    await caller.mongoBooking.admin.users.update({ id: branchUser.id, name: "مستخدم فرع بعد التعديل", email: branchUserEmail, phone: "0552222222", branchId: branchUser.branchId, branchLocationUrl: updatedLocationUrl });
    const manualLink = await branchCaller.mongoBooking.whatsapp.manualLink({ bookingType: "reservation", bookingCode: branchReservation.reservationCode });
    expect(decodeURIComponent(manualLink.url)).toContain(updatedLocationUrl);

    await caller.mongoBooking.admin.users.setActive({ id: branchUser.id, isActive: false });
    expect((await caller.mongoBooking.admin.users.list()).find(user => user.id === branchUser.id)?.isActive).toBe(false);

    await caller.mongoBooking.reservations.cancel({ reservationCode: createdReservation.reservationCode });
    await branchCaller.mongoBooking.reservations.cancel({ reservationCode: branchReservation.reservationCode });
    const db = client.db("sahood_bus_booking");
    const persistedTrip = await db.collection("trips").findOne({ code: tripCode });
    const persistedBranchTrip = await db.collection("trips").findOne({ code: branchTripCode });
    expect(persistedTrip?.bookedSeats).not.toContain(5);
    expect(persistedBranchTrip?.branchId).toBe(branchUser.branchId);
    expect(await db.collection("reservations").countDocuments({ tripCode: { $in: [tripCode, branchTripCode] } })).toBe(0);
  }, 300_000);
});
