import { startMCPServer } from "../mcp/server.js";

export async function mcpCommand(): Promise<void> {
  await startMCPServer();
}
