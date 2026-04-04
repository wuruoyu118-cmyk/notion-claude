import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 【请在这里填入你的钥匙】
const MY_NOTION_TOKEN = "这里直接填入你那串ntn_开头的钥匙"; 
const notion = new Client({ auth: MY_NOTION_TOKEN });

// 用于存储每个会话对应的 transport
const sessions = new Map();

// 处理连接请求的路由
app.get("/mcp", async (req, res) => {
  console.log("收到新的连接请求，正在创建独立服务器实例...");

  // 1. 按照官方建议，为每个连接创建一个全新的 Server 实例，彻底解决“Already connected”报错
  const server = new Server(
    { name: "notion-mcp-anzhi", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  // 2. 在这个独立的实例上注册工具
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "append_to_notion_page",
        description: "向 Notion 页面追加内容",
        inputSchema: {
          type: "object",
          properties: { pageId: { type: "string" }, content: { type: "string" } },
          required: ["pageId", "content"]
        }
      },
      {
        name: "read_latest_time_nodes",
        description: "精准读取底部 N 个 2026.04.05 格式的内容",
        inputSchema: {
          type: "object",
          properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } },
          required: ["pageId"]
        }
      }
    ]
  }));

  // 3. 实现具体逻辑
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === "append_to_notion_page") {
      await notion.blocks.children.append({
        block_id: args.pageId,
        children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] } }]
      });
      return { content: [{ type: "text", text: "写入成功" }] };
    }

    if (name === "read_latest_time_nodes") {
      const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
      const blocks = response.results;
      const timePattern = /\d{4}\.\d{2}\.\d{2}/;
      const getTxt = (b) => b[b.type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
      
      let nodeIndices = [];
      for (let i = 0; i < blocks.length; i++) {
        if (timePattern.test(getTxt(blocks[i]))) nodeIndices.push(i);
      }
      
      let startIndex = blocks.length > 30 ? blocks.length - 30 : 0;
      if (nodeIndices.length > 0) {
        const count = args.nodeCount || 3;
        startIndex = nodeIndices[Math.max(0, nodeIndices.length - count)];
      }
      
      const text = blocks.slice(startIndex).map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
      return { content: [{ type: "text", text }] };
    }
  });

  // 4. 创建传输通道并建立连接
  const transport = new SSEServerTransport("/messages", res);
  
  // 将这个 session 存起来，方便后面的 POST 接口找到
  sessions.set(transport.sessionId, transport);
  
  res.on("close", () => {
    console.log(`会话 ${transport.sessionId} 已关闭`);
    sessions.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// 处理后续消息的路由
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send("Session not found");
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`【终极修复版】服务已启动，端口: ${port}`);
});