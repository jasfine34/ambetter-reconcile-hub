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
  name: "get_batch_summary",
  title: "Get batch summary",
  description:
    "Return aggregate counts and totals for a batch: reconciled members, actual vs estimated-missing commission.",
  inputSchema: {
    batch_id: z.string().uuid().describe("Upload batch id."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ batch_id }) => {
    const supabase = db();
    const [batchRes, membersRes] = await Promise.all([
      supabase
        .from("upload_batches")
        .select("id, carrier, statement_month, notes")
        .eq("id", batch_id)
        .maybeSingle(),
      supabase
        .from("reconciled_members")
        .select(
          "actual_commission, estimated_missing_commission, in_ede, in_back_office, in_commission, issue_type",
        )
        .eq("batch_id", batch_id),
    ]);
    if (batchRes.error)
      return { content: [{ type: "text", text: batchRes.error.message }], isError: true };
    if (membersRes.error)
      return { content: [{ type: "text", text: membersRes.error.message }], isError: true };

    const rows = membersRes.data ?? [];
    const num = (v: unknown) => (typeof v === "number" ? v : v ? Number(v) : 0);
    const summary = {
      batch: batchRes.data,
      member_count: rows.length,
      totals: {
        actual_commission: rows.reduce((s, r) => s + num(r.actual_commission), 0),
        estimated_missing_commission: rows.reduce(
          (s, r) => s + num(r.estimated_missing_commission),
          0,
        ),
      },
      presence: {
        in_ede: rows.filter((r) => r.in_ede).length,
        in_back_office: rows.filter((r) => r.in_back_office).length,
        in_commission: rows.filter((r) => r.in_commission).length,
      },
      by_issue_type: rows.reduce<Record<string, number>>((acc, r) => {
        const k = r.issue_type ?? "none";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
