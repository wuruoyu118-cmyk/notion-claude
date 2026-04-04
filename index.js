import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 初始化 Notion 客户端
const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 创建 MCP Server
const server = new Server(
  { name: "notion-sse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 注册工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_to_notion_page",
      description: "向指定的 Notion 页面写入内容",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          content: { type: "string", description: "要写入的内容" }
        },
        required: ["pageId", "content"]
      }
    }
  ]
}));

// 工具执行逻辑
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
  throw new Error("工具未找到");
});

// 用于管理多会话的 Map
const transports = new Map();

// 【修改重点】：这里改成了 /mcp，匹配你那个运行成功的环境
app.get("/mcp", async (req, res) => {
  console.log("收到连接请求...");
  
  // 创建传输实例，并将消息路由指向下面的 /messages
  const transport = new SSEServerTransport("/messages", res);
  
  // 存储会话
  transports.set(transport.sessionId, transport);
  
  res.on("close", () => {
    console.log(`会话 ${transport.sessionId} 已断开`);
    transports.delete(transport.sessionId);
  });
  
  await server.connect(transport);
  console.log(`Claude 已通过 /mcp 成功连接`);
});

// 处理消息的 POST 接口
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send("会话不存在");
  }
  
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务已启动，请尝试访问：/mcp`);
});