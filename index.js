import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 【核心修复】：不再用写死的字符串，回归标准的环境变量读取
const notionToken = process.env.NOTION_API_KEY;
const notion = new Client({ auth: notionToken });

// 每一个连接进来，我们都给它现场生成一个独立的 Server 实例，防止“Already connected”报错
app.get("/mcp", async (req, res) => {
  if (!notionToken) {
    console.error("错误：Railway 环境变量 NOTION_API_KEY 未找到！");
    return res.status(500).send("Server configuration error: missing API key");
  }

  console.log("收到连接，正在启动独立 MCP Server...");

  const server = new Server(
    { name: "notion-mcp-anzhi", version: "1.2.0" },
    { capabilities: { tools: {} } }
  );

  // 注册工具：追加写入和按时间节点读取
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
        description: "从底部向上读取 N 个 2026.04.05 格式的时间节点内容",
        inputSchema: {
          type: "object",
          properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } },
          required: ["pageId"]
        }
      }
    ]
  }));

  // 实现工具逻辑
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

  const transport = new SSEServerTransport("/messages", res);
  // 为每个会话创建独立的处理器
  const transportHandler = async (req, res) => {
    await transport.handlePostMessage(req, res);
  };

  // 将处理函数存入 app.locals 以便 POST 路由调用（简单处理方案）
  app.set(`handler_${transport.sessionId}`, transportHandler);

  res.on("close", () => {
    app.set(`handler_${transport.sessionId}`, null);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const handler = app.get(`handler_${sessionId}`);
  if (handler) {
    await handler(req, res);
  } else {
    res.status(404).send("Session not found");
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务启动，正在通过环境变量读取 Token。端口: ${port}`);
});