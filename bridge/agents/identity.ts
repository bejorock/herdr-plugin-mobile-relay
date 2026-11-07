import { createHash } from "node:crypto";

/** Private adapter identity. Not a public conversation or pane lifecycle contract. */
export function agentBindingIdFor(input: {
  herdrSession: string; paneId: string; agent: string; nativeSource?: string; nativeValue?: string;
}): string {
  return `herdr_${createHash("sha256").update(JSON.stringify(input)).digest("base64url").slice(0, 32)}`;
}
