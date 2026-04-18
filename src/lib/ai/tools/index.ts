import type { DispatchResult, ToolCtx, ToolDef } from "./types";
import { listCampaignsTool } from "./list_campaigns";
import { campaignDetailTool } from "./campaign_detail";
import { searchContactsTool } from "./search_contacts";
import { recentActivityTool } from "./recent_activity";
import { draftCampaignTool } from "./draft_campaign";
import { proposeSendTool } from "./propose_send";

// The AI tool registry. Tools self-register by being pushed into
// `tools` below (one file per tool, imported here). For the scaffold
// commit the registry is deliberately empty — the first real tool
// (list_campaigns) lands in the next push.
//
// The dispatcher is a thin wrapper: it validates the tool name,
// optionally runs the tool's own input validator, enforces the
// destructive-scope confirmation gate (set by the chat route — a
// destructive tool NEVER executes here, it always short-circuits to
// an error that the route turns into a Confirm directive), and
// catches handler exceptions so they land in the tool_result stream
// instead of 500ing the SSE connection.
//
// Dispatch is NOT where authentication happens. Callers (the /api/chat
// route) are responsible for building ctx from an authenticated user
// and for the rate limiter. Dispatch assumes ctx is trustworthy.

// Typed-to-untyped cast via `unknown` is deliberate. Each tool
// declares its own `Input` shape on `ToolDef<Input>` so handlers
// can trust narrowed fields — but the registry holds the set as a
// uniform `ToolDef`. A direct `as ToolDef` fails when Input has
// required fields (the handler signature isn't assignable to
// `(input: Record<string, unknown>, …)`), so we go through
// `unknown`. Dispatch is still safe: the per-tool `validate()`
// runs before the handler sees the input, turning any
// mis-shaped object into a structured error result.
export const tools: ToolDef[] = [
  listCampaignsTool as unknown as ToolDef,
  campaignDetailTool as unknown as ToolDef,
  searchContactsTool as unknown as ToolDef,
  recentActivityTool as unknown as ToolDef,
  draftCampaignTool as unknown as ToolDef,
  proposeSendTool as unknown as ToolDef,
];

export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

export function listTools(): ToolDef[] {
  return tools;
}

// Options to the dispatcher. `allowDestructive` is false by default —
// the chat route passes true only AFTER the user has clicked confirm
// on a previously-proposed destructive action. Unsolicited destructive
// tool calls from the model are intercepted here and returned as an
// error; the route then emits a Confirm directive client-side.
export type DispatchOpts = {
  allowDestructive?: boolean;
};

export async function dispatch(
  name: string,
  rawInput: unknown,
  ctx: ToolCtx,
  opts: DispatchOpts = {},
): Promise<DispatchResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, error: `unknown_tool:${name}` };

  if (tool.scope === "destructive" && !opts.allowDestructive) {
    return {
      ok: false,
      error: "needs_confirmation",
    };
  }

  // Best-effort input coercion. If the tool supplies a validator we
  // use it; otherwise we require an object and pass it through.
  let input: Record<string, unknown>;
  try {
    if (tool.validate) {
      input = tool.validate(rawInput) as Record<string, unknown>;
    } else if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      input = rawInput as Record<string, unknown>;
    } else {
      return { ok: false, error: "invalid_input:expected_object" };
    }
  } catch (e) {
    return { ok: false, error: `invalid_input:${String(e).slice(0, 160)}` };
  }

  try {
    const result = await tool.handler(input, ctx);
    return { ok: true, result };
  } catch (e) {
    // Handlers should prefer returning structured errors in `output`,
    // but any uncaught throw lands here and is surfaced to the model
    // as a recoverable tool error.
    return { ok: false, error: `handler_error:${String(e).slice(0, 200)}` };
  }
}
