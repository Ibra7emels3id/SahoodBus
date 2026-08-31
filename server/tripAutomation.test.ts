import { describe, expect, it } from "vitest";
import { buildFeedbackPrompt, buildTripReminderText, shouldAutoCloseTrip } from "./tripAutomation";

describe("رسائل تشغيل الرحلات التلقائية", () => {
  const reservation = { passengerName: "إبراهيم", seatNumber: 7, tripCode: "SH-100", branchName: "فرع العزيزية", branchContactPhone: "+966500000000", branchLocationUrl: "https://maps.example.com/branch" };
  const trip = { routeName: "جدة ← الرياض", departureAt: new Date("2026-08-30T12:00:00Z") };

  it("يضمّن التذكير بيانات الرحلة والمقعد وتواصل الفرع", () => {
    const text = buildTripReminderText(reservation, trip);
    expect(text).toContain("تذكير بموعد الرحلة");
    expect(text).toContain("المقعد: 7");
    expect(text).toContain("اسم الفرع: فرع العزيزية");
    expect(text).toContain("موقع الفرع: https://maps.example.com/branch");
  });

  it("يطلب تقييم الخدمة أو وصف المشكلة بطريقة واضحة", () => {
    const text = buildFeedbackPrompt(reservation, trip);
    expect(text).toContain("اكتب 1");
    expect(text).toContain("Google Maps");
    expect(text).toContain("اكتب 2");
  });

  it("يغلق فقط الرحلات التي تجاوزت موعدها ولم تكن مغلقة بالفعل", () => {
    const now = new Date("2026-08-30T12:00:00Z");
    expect(shouldAutoCloseTrip({ status: "open", departureAt: "2026-08-30T11:59:00Z" }, now)).toBe(true);
    expect(shouldAutoCloseTrip({ status: "departed", departureAt: "2026-08-30T11:59:00Z" }, now)).toBe(true);
    expect(shouldAutoCloseTrip({ status: "closed", departureAt: "2026-08-30T11:59:00Z" }, now)).toBe(false);
    expect(shouldAutoCloseTrip({ status: "open", departureAt: "2026-08-30T12:01:00Z" }, now)).toBe(false);
  });
});
