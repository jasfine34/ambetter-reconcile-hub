import { defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";
import listBatchesTool from "./tools/listBatches";
import getBatchSummaryTool from "./tools/getBatchSummary";
import listMembersTool from "./tools/listMembers";
import getMemberTimelineTool from "./tools/getMemberTimeline";

export default defineMcp({
  name: "ambetter-reconcile-hub-mcp",
  title: "Ambetter Reconcile Hub MCP",
  version: "0.2.0",
  instructions:
    "Public MCP server for Ambetter Reconcile Hub. Read-only tools over commission upload batches and reconciled members. Start with `list_batches`, then `get_batch_summary` or `list_members` for a batch, and `get_member_timeline` to trace a single member. No authentication required.",
  tools: [
    echoTool,
    listBatchesTool,
    getBatchSummaryTool,
    listMembersTool,
    getMemberTimelineTool,
  ],
});
