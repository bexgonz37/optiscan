import { redirect } from "next/navigation";

/** /stocks merged into Live — session-aware watchlist on /. */
export default function StocksRedirect() {
  redirect("/");
}
