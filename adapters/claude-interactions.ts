// Native Claude hook entrypoint: stdin JSON, stdout native hook decision only.
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

export function claudeRequest(input: any): any | null {
  const kind = input.hook_event_name;
  const tool = input.tool_name;
  const args = input.tool_input;
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof tool !== "string") return null;
  const base = { kind: "interaction.request", interactionId: `claude:${randomUUID()}`, toolCallId: input.tool_use_id,
    executionId: input.agent_id, timeoutMs: 225000 };
  if (kind === "PermissionRequest") return { ...base, interactionKind: "permission", title: `Claude requests permission: ${tool}`, description: JSON.stringify(args).slice(0, 2048),
    options: [{ optionId: "allow_once", name: "Allow once" }, { optionId: "reject_once", name: "Deny" }] };
  if (kind !== "PreToolUse") return null;
  if (tool === "ExitPlanMode" && typeof args.plan === "string" && args.plan.length <= 48000) return { ...base, interactionKind: "permission", title: "Approve Claude's plan", plan: { planId: base.interactionId, content: args.plan },
    options: [{ optionId: "allow_once", name: "Approve plan" }, { optionId: "reject_once", name: "Keep planning" }] };
  if (tool !== "AskUserQuestion" || !Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 4) return null;
  const properties: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [i, q] of args.questions.entries()) {
    if (!q || typeof q.question !== "string" || q.question.length > 1024 || !q.question || seen.has(q.question) || typeof q.header !== "string" || !q.header || q.header.length > 128 || !Array.isArray(q.options) || q.options.length < 1 || q.options.length > 32 || (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")) return null;
    seen.add(q.question);
    const labels = q.options.map((option: any) => option?.label);
    if (labels.some((label: unknown) => typeof label !== "string" || !label || label.length > 128 || (q.multiSelect && label.includes(","))) || new Set(labels).size !== labels.length) return null;
    const choices = labels.map((label: string) => ({ const: label, title: label }));
    properties[`q${i + 1}`] = { title: q.header, description: q.question, ...(q.multiSelect ? { type: "array", items: { type: "string", oneOf: choices }, minItems: 1, maxItems: labels.length } : { type: "string", oneOf: choices }) };
  }
  return { ...base, interactionKind: "elicitation", title: "Claude needs your input", schema: { properties, required: Object.keys(properties) } };
}
export function claudeDecision(input: any, outcome: any): unknown | null {
  if (input.hook_event_name === "PermissionRequest") {
    if (outcome?.optionId === "allow_once") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    if (outcome?.optionId === "reject_once") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Remote user declined" } } };
    return null;
  }
  if (input.tool_name === "ExitPlanMode") {
    if (!["allow_once", "reject_once"].includes(outcome?.optionId)) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: outcome.optionId === "allow_once" ? "allow" : "deny", permissionDecisionReason: outcome.optionId === "allow_once" ? "Remote user approved" : "Remote user declined plan" } };
  }
  if (input.tool_name !== "AskUserQuestion" || outcome?.action !== "accept" || !outcome.content || typeof outcome.content !== "object") return null;
  const event = claudeRequest(input);
  if (!event?.schema || Object.keys(outcome.content).length !== input.tool_input.questions.length) return null;
  const answers: Record<string, string> = {};
  for (const [i, q] of input.tool_input.questions.entries()) {
    const answer = outcome.content[`q${i + 1}`]; const labels = q.options.map((option: any) => option.label);
    if (q.multiSelect) {
      if (!Array.isArray(answer) || !answer.length || new Set(answer).size !== answer.length || !answer.every((v) => labels.includes(v))) return null;
      answers[q.question] = labels.filter((v: string) => answer.includes(v)).join(",");
    } else { if (typeof answer !== "string" || !labels.includes(answer)) return null; answers[q.question] = answer; }
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, answers } } };
}
async function run(): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_RELAY_HOOK_SOCKET) return;
  const raw = await Bun.stdin.text();
  if (Buffer.byteLength(raw) > 128 * 1024) return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (typeof input.session_id !== "string" || input.session_id.length > 256) return;
  const request = claudeRequest(input); if (!request) return;
  await new Promise<void>((resolve) => {
    const socket = createConnection(process.env.HERDR_RELAY_HOOK_SOCKET!);
    let buffer = ""; let ready = false; let finished = false;
    const end = (outcome?: unknown) => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      const decision = claudeDecision(input, outcome); if (decision) process.stdout.write(JSON.stringify(decision) + "\n"); resolve();
    };
    const timer = setTimeout(() => end(), 235000);
    socket.setTimeout(5000, () => end());
    socket.on("connect", () => socket.write(JSON.stringify({ version: 1, type: "hello", adapter: { kind: "claude", name: "herdr-relay", version: "2" }, binding: {
      herdrSession: process.env.HERDR_SESSION || "default", paneId: process.env.HERDR_PANE_ID, agent: "claude", nativeSession: { source: "herdr:claude", agent: "claude", kind: "id", value: input.session_id },
    } }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 64 * 1024) return end();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let value; try { value = JSON.parse(line); } catch { return end(); }
        if (value.type === "hello_ack" && !ready) {
          ready = true; socket.setTimeout(0);
          const frame = JSON.stringify({ version: 1, type: "event", eventId: request.interactionId, sequence: 1, event: request }) + "\n";
          if (Buffer.byteLength(frame) > 64 * 1024) return end(); socket.write(frame);
        }
        if (value.type === "command" && value.command?.kind === "interaction.resolve" && value.command.interactionId === request.interactionId) return end(value.command.outcome);
      }
    });
    socket.on("error", () => end()); socket.on("close", () => end()); socket.on("end", () => end());
  });
}
if (import.meta.main) await run();
