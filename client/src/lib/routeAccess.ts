export type RouteAccessDecision = "allow" | "redirect-login" | "redirect-home" | "loading";

export function resolveRouteAccess({
  isAuthenticated,
  isLoading,
  isLoginRoute,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
  isLoginRoute: boolean;
}): RouteAccessDecision {
  if (isLoading) return "loading";
  if (isLoginRoute) return isAuthenticated ? "redirect-home" : "allow";
  return isAuthenticated ? "allow" : "redirect-login";
}
