import { redirect } from "next/navigation";

/** Legacy URL — canonical route is /alerts */
export default function AlertLabRedirect() {
  redirect("/alerts");
}
