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
      return { content: [{ type: "text", text: `成功写入 Notion` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }
  throw new Error("没找到工具");
});

// 【核心修改1】：使用 Map 存储多会话，符合标准云端架构
const transports = new Map();

app.get("/sse", async (req, res) => {
  // 生成标准的 SSE 端点
  const transport = new SSEServerTransport("/messages", res);
  
  // 记录该会话分配的 sessionId
  transports.set(transport.sessionId, transport);
  
  // 客户端连接断开时，按照规范清理内存
  res.on("close", () => {
    transports.delete(transport.sessionId);
  });
  
  await server.connect(transport);
});

// 【核心修改2】：移除 express.json()，避免破坏 SDK 原生格式
app.post("/messages", async (req, res) => {
  // 【核心修改3】：严格根据 URL 传入的 sessionId 提取对应通道
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send("Session not found");
  }
  
  // 将原生的请求转交给 transport 处理
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`MCP 标准规范版服务器运行中，端口: ${port}`);
});