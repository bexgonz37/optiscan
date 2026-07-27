/**
 * UI review / screenshot mode — clearly labeled demo presentation only.
 * Never enabled in production deploys. Activate locally via:
 *   NEXT_PUBLIC_OPTISCAN_UI_REVIEW=1  OR  localStorage optiscan:uiReview=1
 */
export function isUiReviewMode(): boolean {
  if (typeof window !== "undefined") {
    try {
      if (localStorage.getItem("optiscan:uiReview") === "1") return true;
    } catch { /* ignore */ }
  }
  return process.env.NEXT_PUBLIC_OPTISCAN_UI_REVIEW === "1";
}
