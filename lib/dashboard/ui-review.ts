/**
 * UI review / screenshot mode — clearly labeled demo presentation only.
 * Never enabled in production deploys. Activate locally via:
 *   NEXT_PUBLIC_OPTISCAN_UI_REVIEW=1  OR  localStorage optiscan:uiReview=1
 *
 * Optional session simulation for screenshots:
 *   localStorage optiscan:uiReviewSession = regular | premarket | afterhours | overnight | weekend
 */
export type UiReviewSession = "regular" | "premarket" | "afterhours" | "overnight" | "weekend";

export function isUiReviewMode(): boolean {
  if (typeof window !== "undefined") {
    try {
      if (localStorage.getItem("optiscan:uiReview") === "1") return true;
    } catch { /* ignore */ }
  }
  return process.env.NEXT_PUBLIC_OPTISCAN_UI_REVIEW === "1";
}

export function getUiReviewSession(): UiReviewSession | null {
  if (!isUiReviewMode()) return null;
  if (typeof window !== "undefined") {
    try {
      const s = localStorage.getItem("optiscan:uiReviewSession");
      if (s === "regular" || s === "premarket" || s === "afterhours" || s === "overnight" || s === "weekend") {
        return s;
      }
    } catch { /* ignore */ }
  }
  const env = process.env.NEXT_PUBLIC_OPTISCAN_UI_REVIEW_SESSION;
  if (env === "regular" || env === "premarket" || env === "afterhours" || env === "overnight" || env === "weekend") {
    return env;
  }
  return "regular";
}
