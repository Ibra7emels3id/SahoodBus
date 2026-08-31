import { describe, expect, it } from "vitest";
import { buildBookingMessage, buildManualWhatsAppUrl, normalizeWasenderMessageStatus, normalizeWhatsAppPhone } from "./wasender";

describe("Wasender credentials", () => {
  it("builds a readable booking message with complete branch details", () => {
    const message = buildBookingMessage({ reservationCode: "RES-1", passengerName: "راكب", phone: "+966500000000", tripCode: "SH-1", seatNumber: 4, ticketPrice: 100, branchName: "فرع العزيزية", branchContactPhone: "+966511111111", branchLocationUrl: "https://maps.google.com/?q=suhoud" }, "reservation");
    expect(message).toContain("اسم الفرع: فرع العزيزية");
    expect(message).toContain("رقم الفرع: +966511111111");
    expect(message).toContain("موقع الفرع: https://maps.google.com/?q=suhoud");
    expect(message).toContain("\nرقم الحجز: RES-1");
    expect(message).not.toContain("\\n");
  });
  it("builds a manual WhatsApp link without treating it as delivery", () => {
    const url = buildManualWhatsAppUrl("0500000000", "تفاصيل حجز\nرقم: SH-1", "966");
    expect(url).toContain("https://wa.me/966500000000?text=");
    expect(url).toContain(encodeURIComponent("تفاصيل حجز\nرقم: SH-1"));
    expect(url).not.toContain("delivered");
  });
  it("normalizes Saudi local numbers and formats trust messages", () => {
    expect(normalizeWhatsAppPhone("0500000000")).toBe("+966500000000");
    expect(normalizeWhatsAppPhone("500000000")).toBe("+966500000000");
    const message = buildBookingMessage({ trustCode: "TR-1", senderName: "مرسل", recipientName: "مستلم", itemDescription: "حقيبة", itemCount: 1, fee: 25, tripCode: "SH-1" }, "trust");
    expect(message).toContain("رقم الأمانة: TR-1");
    expect(message).toContain("المستلم: مستلم");
  });
  it("maps Wasender delivery and read status codes to dashboard states", () => {
    expect(normalizeWasenderMessageStatus(2)).toBe("sent");
    expect(normalizeWasenderMessageStatus(3)).toBe("delivered");
    expect(normalizeWasenderMessageStatus(4)).toBe("read");
    expect(normalizeWasenderMessageStatus("3")).toBe("delivered");
  });
  it("accepts the configured personal access token", async () => {
    const token = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
    expect(token, "WASENDER_PERSONAL_ACCESS_TOKEN must be configured").toBeTruthy();

    const response = await fetch("https://www.wasenderapi.com/api/whatsapp-sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expect(response.ok).toBe(true);
  }, 30_000);
});

export {};

function keepTestModule(): void {
  // Keeps this standalone test an explicit credential health check.
}

void keepTestModule;

// Never print or expose the token in test output.
