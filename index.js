import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 【开机自检】：检查环境变量是否正确读取
console.log("--- 服务器启动检查 ---");
const token = process.env.NOTION_API_KEY;

if (!token) {
  console.error("【致命错误】：未找到 NOTION_API_KEY！请检查 Railway 的 Variables 设置。");
} else {
  // 只打印前几个字母和长度，确保安全的同时确认它读到了
  console.log(`【钥匙检查】：已读到钥匙，开头是: ${token.substring(0, 7)}... 长度为: ${token.length}`);
}
console.log("--- 检查结束 ---");

// 初始化 Notion 客户端
const notion = new Client({ auth: token });

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
          pageId: { type: "string", description: "Notion页面的ID" },
          content: { type: "string", description: "要写入的内容" }
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
      // 这里的报错会直接传回给 Claude，让我们看到原因
      return { content: [{ type: "text", text: `Notion 报错: ${error.message}` }] };
    }
  }
  throw new Error("工具未找到");
});

const transports = new Map();

app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => {
    transports.delete(transport.sessionId);
  });
  await server.connect(transport);
  console.log(`Claude 已成功连接`);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send("会话不存在");
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务正在 0.0.0.0:${port} 运行`);
});