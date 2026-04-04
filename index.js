import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 【这里填入你那串钥匙】
const MY_NOTION_TOKEN = "这里填入你那串ntn_开头的钥匙"; 
const notion = new Client({ auth: MY_NOTION_TOKEN });

const server = new Server(
  { name: "notion-sse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_to_notion_page",
      description: "追加内容到底部",
      inputSchema: {
        type: "object",
        properties: { pageId: { type: "string" }, content: { type: "string" } },
        required: ["pageId", "content"]
      }
    },
    {
      name: "read_latest_time_nodes",
      description: "读取最近 N 个 2026.04.05 格式的内容",
      inputSchema: {
        type: "object",
        properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } },
        required: ["pageId"]
      }
    }
  ]
}));

// 极其稳健的取词函数
const safeGetText = (block) => {
  try {
    const type = block.type;
    return block[type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
  } catch (e) { return ""; }
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === "append_to_notion_page") {
    try {
      await notion.blocks.children.append({
        block_id: args.pageId,
        children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] } }]
      });
      return { content: [{ type: "text", text: "写入成功" }] };
    } catch (e) { return { content: [{ type: "text", text: "写入失败: " + e.message }] }; }
  }

  if (name === "read_latest_time_nodes") {
    try {
      // 1. 只抓取最后一页（最近 100 个块），防止由于循环翻页导致的连接超时
      const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
      const blocks = response.results;
      
      const timePattern = /\d{4}\.\d{2}\.\d{2}/;
      let nodeIndices = [];
      
      // 2. 标记所有日期的位置
      for (let i = 0; i < blocks.length; i++) {
        if (timePattern.test(safeGetText(blocks[i]))) nodeIndices.push(i);
      }

      // 3. 【保底逻辑】：如果没找到日期，就读最后 30 行；找到了，就按要求切
      let startIndex = blocks.length > 30 ? blocks.length - 30 : 0;
      if (nodeIndices.length > 0) {
        const count = args.nodeCount || 3;
        startIndex = nodeIndices[Math.max(0, nodeIndices.length - count)];
      }

      const finalContent = blocks.slice(startIndex).map(b => safeGetText(b)).filter(t => t.trim()).join('\n\n');
      return { content: [{ type: "text", text: finalContent || "页面没东西可读" }] };
    } catch (e) { return { content: [{ type: "text", text: "读取崩溃: " + e.message }] }; }
  }
});

const transports = new Map();
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (transport) await transport.handlePostMessage(req, res);
  else res.status(404).send("Session Lost");
});

app.listen(port, "0.0.0.0");