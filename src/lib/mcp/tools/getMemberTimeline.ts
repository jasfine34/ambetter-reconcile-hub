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
  name: "get_member_timeline",
  title: "Get member timeline",
  description:
    "Return all normalized records (BO, EDE, commission) for a member_key across batches, newest first.",
  inputSchema: {
    member_key: z.string().min(1).describe("Stable member key."),
    limit: z.number().int().min(1).max(500).default(200),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ member_key, limit }) => {
    const { data, error } = await db()
      .from("normalized_records")
      .select(
        "id, batch_id, source_type, source_file_label, carrier, applicant_name, policy_number, issuer_subscriber_id, agent_name, agent_npn, pay_entity, status, effective_date, paid_through_date, premium, net_premium, commission_amount, months_paid, created_at",
      )
      .eq("member_key", member_key)
      .is("superseded_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error)
      return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { records: data ?? [] },
    };
  },
});
