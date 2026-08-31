import { describe, expect, it } from "vitest";
import { validateTripDraft } from "../shared/tripForm";

const validTrip = {
  primaryDriverName: "محمد الشمري",
  secondDriverName: "ناصر الحربي",
  busNumber: "سهود 25",
  routeName: "الرياض ← المدينة",
  departureDate: "2026-08-25",
  departureTime: "07:30",
  capacity: "32",
};

describe("نموذج إضافة رحلة", () => {
  it("يقبل بيانات الرحلة المكتملة ويحوّل السعة إلى رقم", () => {
    expect(validateTripDraft(validTrip)).toEqual({ valid: true, capacity: 32 });
  });

  it("يرفض الحقول الناقصة والسعة خارج المدى", () => {
    expect(validateTripDraft({ ...validTrip, secondDriverName: "" }).valid).toBe(false);
    expect(validateTripDraft({ ...validTrip, capacity: "81" }).valid).toBe(false);
  });
});
