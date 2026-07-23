import { defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";

export default defineMcp({
  name: "ambetter-reconcile-hub-mcp",
  title: "Ambetter Reconcile Hub MCP",
  version: "0.1.0",
  instructions:
    "Public MCP server for Ambetter Reconcile Hub. Use `echo` to verify connectivity. No authentication required.",
  tools: [echoTool],
});
