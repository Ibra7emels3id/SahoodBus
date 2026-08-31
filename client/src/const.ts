export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/** Navigate to the local email/password screen from an interaction. */
export const startLogin = () => {
  window.location.assign("/login");
};
