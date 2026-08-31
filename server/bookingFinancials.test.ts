import { describe, expect, it } from "vitest";
import { calculateExternalOfficeRevenue, calculateOfficeRevenue } from "../shared/bookingFinancials";

describe("حساب إيراد المكتب", () => {
  it("يحسب المتبقي للمكتب بعد خصم عمولة السائق", () => {
    expect(calculateOfficeRevenue(100, 60)).toEqual({ valid: true, officeRevenue: 40 });
  });

  it("يرفض العمولة التي تتجاوز قيمة التذكرة", () => {
    expect(calculateOfficeRevenue(100, 120).valid).toBe(false);
  });

  it("يحسب صافي المكتب في الحجز الخارجي بعد رسوم المكتب الخارجي", () => {
    expect(calculateExternalOfficeRevenue(100, 35)).toEqual({ valid: true, officeRevenue: 65 });
    expect(calculateExternalOfficeRevenue(100, 120).message).toContain("رسوم المكتب الخارجي");
  });
});
