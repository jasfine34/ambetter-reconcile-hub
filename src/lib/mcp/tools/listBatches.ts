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
  name: "list_batches",
  title: "List upload batches",
  description:
    "List commission upload batches (carrier, statement month, notes) most recent first.",
  inputSchema: {
    carrier: z.string().optional().describe("Filter by carrier (e.g. 'Ambetter')."),
    limit: z.number().int().min(1).max(200).default(50).describe("Max batches."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ carrier, limit }) => {
    let q = db()
      .from("upload_batches")
      .select("id, carrier, statement_month, notes, created_at, last_full_rebuild_at")
      .order("statement_month", { ascending: false })
      .limit(limit);
    if (carrier) q = q.eq("carrier", carrier);
    const { data, error } = await q;
    if (error)
      return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { batches: data ?? [] },
    };
  },
});
