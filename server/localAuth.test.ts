import { describe, expect, it } from "vitest";
import { completeLocalPasswordReset, createLocalBranchUser, getLocalUserFromToken, issueLocalPasswordReset, loginWithEmailPassword } from "./localAuth";

describe("الدخول المحلي", () => {
  it("يتحقق من بيانات مدير النظام المخزنة في الأسرار", async () => {
    const email = process.env.LOCAL_ADMIN_EMAIL;
    const password = process.env.LOCAL_ADMIN_PASSWORD;
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();
    const result = await loginWithEmailPassword(email!, password!);
    expect(result?.token).toBeTruthy();
    expect(result?.user.email).toBe(email!.trim().toLowerCase());
    expect(result?.user.role).toBe("admin");
    await expect(getLocalUserFromToken(result!.token)).resolves.toMatchObject({ email: email!.trim().toLowerCase(), role: "admin" });
  }, 30_000);

  it("يرفض كلمة المرور غير الصحيحة", async () => {
    const result = await loginWithEmailPassword(process.env.LOCAL_ADMIN_EMAIL!, "invalid-password-value");
    expect(result).toBeNull();
  }, 30_000);

  it("يغيّر كلمة المرور برمز مؤقت من دون إرجاعه إلى واجهة عامة", async () => {
    const email = `reset-${Date.now()}@example.test`;
    await createLocalBranchUser({ email, password: "OriginalPass123!", name: "مستخدم استعادة", phone: "0555555555" });
    const reset = await issueLocalPasswordReset(email);
    expect(reset?.code).toMatch(/^\d{6}$/);
    await expect(completeLocalPasswordReset({ email, code: reset!.code, password: "NewPass456!" })).resolves.toBe(true);
    await expect(loginWithEmailPassword(email, "OriginalPass123!")).resolves.toBeNull();
    await expect(loginWithEmailPassword(email, "NewPass456!")).resolves.toMatchObject({ user: { email } });
  }, 60_000);
});
