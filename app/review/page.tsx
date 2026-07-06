import { redirect } from "next/navigation";

export default function ReviewRedirect() {
  redirect("/alerts?tab=history#how-it-works");
}
