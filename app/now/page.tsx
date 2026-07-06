import { redirect } from "next/navigation";

/** /now merged into the main dashboard. */
export default function NowRedirect() {
  redirect("/");
}
