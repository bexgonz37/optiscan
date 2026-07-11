import { redirect } from "next/navigation";

/** /stocks renamed to /watchlist (Phase 5). Redirect preserves old links. */
export default function StocksRedirect() {
  redirect("/watchlist");
}
