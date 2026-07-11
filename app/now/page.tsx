import { redirect } from "next/navigation";

/** /now → the live scanner (moved to /scanner when "/" became the Command Center). */
export default function NowRedirect() {
  redirect("/scanner");
}
