import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;
const notion = new Client({ auth: process.env.NOTION_API_KEY });

const server = new Server(
  { name: "notion-sse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_to_notion_page",
      description: "向指定的 Notion 页面写入内容",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID，从网址里获取" },
          content: { type: "string", description: "要写入的具体内容" }
        },
        required: ["pageId", "content"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "append_to_notion_page") {
    const { pageId, content } = request.params.arguments;
    try {
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: content } }] } }
        ]
      });
      return { content: [{ type: "text", text: `成功写进 Notion 啦！` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }
  throw new Error("没找到工具");
});

let transport;
app.get("/sse", async (req, res) => {
  const messageEndpoint = `https://${req.headers.host}/messages`;
  transport = new SSEServerTransport(messageEndpoint, res);
  await server.connect(transport);
  console.log("Claude 已连接 SSE");
});

app.post("/messages", express.json(), async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(503).send("还没连接上");
  }
});

// 【核心修改】：绑定 0.0.0.0 适应 Railway 容器
app.listen(port, "0.0.0.0", () => {
  console.log(`运行中，端口: ${port}`);
});