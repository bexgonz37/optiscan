import { redirect } from "next/navigation";

/** /now permanently redirects to the unified NOW page at /. */
export default function NowRedirect() {
  redirect("/");
}
