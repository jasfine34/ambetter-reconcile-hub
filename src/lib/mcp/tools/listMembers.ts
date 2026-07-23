import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

function db() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export default defineTool({
  name: "list_members",
  title: "List reconciled members",
  description:
    "List reconciled members for a batch with optional filters (agent NPN, issue type, name substring).",
  inputSchema: {
    batch_id: z.string().uuid().describe("Upload batch id."),
    agent_npn: z.string().optional().describe("Filter by agent NPN."),
    issue_type: z.string().optional().describe("Filter by issue_type."),
    name_contains: z.string().optional().describe("Case-insensitive applicant name match."),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ batch_id, agent_npn, issue_type, name_contains, limit }) => {
    let q = db()
      .from("reconciled_members")
      .select(
        "member_key, applicant_name, agent_name, agent_npn, policy_number, issuer_subscriber_id, expected_pay_entity, actual_pay_entity, actual_commission, estimated_missing_commission, issue_type, issue_notes",
      )
      .eq("batch_id", batch_id)
      .limit(limit);
    if (agent_npn) q = q.eq("agent_npn", agent_npn);
    if (issue_type) q = q.eq("issue_type", issue_type);
    if (name_contains) q = q.ilike("applicant_name", `%${name_contains}%`);
    const { data, error } = await q;
    if (error)
      return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { members: data ?? [] },
    };
  },
});
