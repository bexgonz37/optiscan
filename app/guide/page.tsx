import { redirect } from "next/navigation";

export default function GuideRedirect() {
  redirect("/settings#help");
}
