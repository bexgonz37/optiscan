import { randomUUID } from "node:crypto";

export function brokerId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
