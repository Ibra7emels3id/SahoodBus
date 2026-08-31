import { describe, expect, it } from "vitest";
import { resolveRouteAccess } from "./routeAccess";

describe("resolveRouteAccess", () => {
  it("يحمي صفحات النظام عند فقدان الجلسة", () => {
    expect(resolveRouteAccess({ isAuthenticated: false, isLoading: false, isLoginRoute: false })).toBe("redirect-login");
  });

  it("يبقي المستخدم المصرح له داخل صفحات النظام ويخرجه من صفحة الدخول", () => {
    expect(resolveRouteAccess({ isAuthenticated: true, isLoading: false, isLoginRoute: false })).toBe("allow");
    expect(resolveRouteAccess({ isAuthenticated: true, isLoading: false, isLoginRoute: true })).toBe("redirect-home");
  });

  it("لا يعيد التوجيه قبل اكتمال فحص الجلسة", () => {
    expect(resolveRouteAccess({ isAuthenticated: false, isLoading: true, isLoginRoute: false })).toBe("loading");
  });
});
