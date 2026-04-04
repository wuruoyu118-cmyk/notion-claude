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
const MY_NOTION_TOKEN = "这里填入你那串ntn_开头的钥匙"; 

const notion = new Client({ auth: MY_NOTION_TOKEN });

const server = new Server(
  { name: "notion-sse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- 1. 注册工具列表 ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_to_notion_page",
      description: "向指定的 Notion 页面追加文本内容",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          content: { type: "string", description: "要追加的文本内容" }
        },
        required: ["pageId", "content"]
      }
    },
    {
      name: "read_notion_page",
      description: "读取 Notion 页面的文本内容",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          limit: { type: "number", description: "读取最近的多少个内容块，默认为2", default: 2 }
        },
        required: ["pageId"]
      }
    }
  ]
}));

// --- 2. 实现工具逻辑 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // --- 逻辑 A: 追加写入 ---
  if (name === "append_to_notion_page") {
    try {
      await notion.blocks.children.append({
        block_id: args.pageId,
        children: [{
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] }
        }]
      });
      return { content: [{ type: "text", text: `成功写进 Notion 啦！` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }

  // --- 逻辑 B: 读取内容 ---
  if (name === "read_notion_page") {
    try {
      const response = await notion.blocks.children.list({
        block_id: args.pageId,
        page_size: args.limit || 2
      });

      // 提取所有文字内容块
      const textContent = response.results
        .map(block => {
          const type = block.type;
          const richText = block[type]?.rich_text;
          return richText ? richText.map(t => t.plain_text).join('') : '';
        })
        .filter(text => text.length > 0)
        .join('\n\n');

      return {
        content: [{ 
          type: "text", 
          text: textContent || "该页面指定范围内没有文字内容。" 
        }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `读取失败: ${error.message}` }] };
    }
  }

  throw new Error("工具未找到");
});

// --- 3. SSE 连接逻辑 (保持不变) ---
const transports = new Map();
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
  console.log("Claude 已成功连接读取工具");
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send("会话不存在");
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务正在 0.0.0.0:${port} 运行，支持读写功能`);
});