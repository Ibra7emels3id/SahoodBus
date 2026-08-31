import { describe, expect, it } from "vitest";
import { expenseInputSchema, reservationInputSchema, tripInputSchema } from "../shared/contracts";

describe("operational API contracts", () => {
  it("accepts a valid reservation contract", () => {
    const reservation = reservationInputSchema.parse({
      tripId: 7,
      passengerName: "ليان أحمد",
      passengerPhone: "966500000000",
      seatNumber: "A12",
      price: 175,
      paidAmount: 100,
      paymentStatus: "partial",
    });
    expect(reservation.seatNumber).toBe("A12");
  });

  it("rejects an expense without an amount", () => {
    const parsed = expenseInputSchema.safeParse({ branchId: 1, category: "وقود", paidFrom: "cash", occurredAt: Date.now() });
    expect(parsed.success).toBe(false);
  });

  it("requires both route details and seat capacity for a trip", () => {
    const trip = tripInputSchema.parse({
      routeName: "الرياض ← المدينة المنورة",
      busNumber: "سهود 25",
      primaryDriverName: "محمد الشمري",
      secondDriverName: "ناصر الحربي",
      departureDate: "2026-08-25",
      departureTime: "07:30",
      capacity: 32,
    });
    expect(trip.capacity).toBe(32);
    expect(trip.secondDriverName).toBe("ناصر الحربي");
  });
});
