#!/usr/bin/env node
/**
 * goods-server.mjs — deliver_goods as a standalone stdio MCP server.
 *
 * For MCP clients that are not this repo's runners: Codex CLI, Claude Desktop, Cursor, or another agent.
 * Mount it next to paykit's server (paykit/src/server.mjs) and the client has the full seller toolset,
 * with the delivery gate still enforced here, in code, not in the client's prompt.
 *
 *   node goods-server.mjs            # speaks MCP on stdin/stdout; logs go to stderr
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CATALOG, deliverGoods } from './seller-core.mjs';

console.log = (...a) => console.error(...a); // stdout is the MCP channel

const server = new McpServer({ name: 'seller-goods', version: '0.1.0' });
server.registerTool('deliver_goods', {
  title: 'Deliver goods',
  description: 'Release the goods for a settled invoice. Verifies on-chain settlement before releasing; refuses otherwise.',
  inputSchema: { invoice_id: z.string(), product: z.enum(Object.keys(CATALOG)).optional().describe('defaults to market-report') },
}, async (a) => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await deliverGoods(a), null, 2) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});
await server.connect(new StdioServerTransport());
