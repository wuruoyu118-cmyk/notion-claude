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
      description: "向指定的 Notion 页面追加文本内容（写在最下面）",
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
      name: "read_notion_page_bottom",
      description: "从 Notion 页面底部向上读取指定数量的内容块",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          limit: { type: "number", description: "从底部向上读取多少个块，默认5个", default: 5 }
        },
        required: ["pageId"]
      }
    }
  ]
}));

// --- 2. 实现工具逻辑 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // --- 逻辑 A: 追加写入 (保持不变) ---
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
      return { content: [{ type: "text", text: `成功写进 Notion 底部啦！` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }

  // --- 逻辑 B: 从底部向上读取 ---
  if (name === "read_notion_page_bottom") {
    try {
      let allBlocks = [];
      let cursor = undefined;

      // 循环读取所有内容块，直到找到最后一块（确保是真底部）
      // 如果页面极大，为了速度，我们最多只翻页 3 次（即读取最近的 300 个块）
      let safetyCounter = 0;
      do {
        const response = await notion.blocks.children.list({
          block_id: args.pageId,
          start_cursor: cursor,
        });
        allBlocks.push(...response.results);
        cursor = response.next_cursor;
        safetyCounter++;
      } while (cursor && safetyCounter < 3);

      // 取最后 N 个块
      const limit = args.limit || 5;
      const lastBlocks = allBlocks.slice(-limit);

      // 提取文字内容
      const textContent = lastBlocks
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
          text: textContent || "在页面底部没有找到可读的文字内容。" 
        }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `读取失败: ${error.message}` }] };
    }
  }

  throw new Error("工具未找到");
});

// --- 3. SSE 连接逻辑 ---
const transports = new Map();
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
  console.log("Claude 已成功连接【底部读取】工具");
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send("会话不存在");
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务运行中，端口: ${port}。快去睡吧妈咪！`);
});