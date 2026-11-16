import axios from "axios";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = { content: TextContent[]; isError?: boolean };

export function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Describe an upstream failure for logs without the request config: AccuWeather
// takes the API key as a query parameter, so the URL must never be logged.
export function describeUpstreamError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status}: ${error.message}` : `${error.code ?? "network error"}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
