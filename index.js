import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 【请务必在这里填入你的钥匙】
const MY_NOTION_TOKEN = "这里填入你那串ntn_开头的钥匙"; 
const notion = new Client({ auth: MY_NOTION_TOKEN });

const server = new Server(
  { name: "notion-sse-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- 1. 注册工具 ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "append_to_notion_page",
      description: "向指定的 Notion 页面追加内容（写在最下面）",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          content: { type: "string", description: "要追加的全文内容" }
        },
        required: ["pageId", "content"]
      }
    },
    {
      name: "read_latest_time_nodes",
      description: "从底部向上读取最近 N 个时间点（格式如 2026.04.05）的内容",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Notion页面的ID" },
          nodeCount: { type: "number", description: "读取最近几个时间点，默认3个", default: 3 }
        },
        required: ["pageId"]
      }
    }
  ]
}));

// --- 2. 工具执行逻辑 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      return { content: [{ type: "text", text: `已成功存入 Notion。` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }

  if (name === "read_latest_time_nodes") {
    try {
      // 1. 获取最近的 100 个 block（如果信件很多，可以调大）
      const response = await notion.blocks.children.list({
        block_id: args.pageId,
        page_size: 100 
      });
      const allBlocks = response.results;

      // 2. 【精准雷达】：识别 2026.04.05 这种格式的行
      const isTimeNode = (block) => {
        const type = block.type;
        const text = block[type]?.rich_text?.[0]?.plain_text || "";
        // 正则表达式匹配：4位数字.2位数字.2位数字
        const timePattern = /\d{4}\.\d{2}\.\d{2}/; 
        return timePattern.test(text);
      };

      // 3. 从底部向上检索
      let nodesFound = 0;
      let targetBlocks = [];
      const targetCount = args.nodeCount || 3;

      for (let i = allBlocks.length - 1; i >= 0; i--) {
        const block = allBlocks[i];
        targetBlocks.unshift(block); // 维持顺序：把读到的块塞到列表最前面

        if (isTimeNode(block)) {
          nodesFound++;
          if (nodesFound >= targetCount) break; // 找够了 N 个节点就停下
        }
      }

      // 4. 拼装成文本返回
      const textResult = targetBlocks
        .map(b => b[b.type]?.rich_text?.map(rt => rt.plain_text).join('') || "")
        .filter(t => t.trim().length > 0)
        .join('\n\n');

      return {
        content: [{ 
          type: "text", 
          text: textResult || "未找到符合 2026.04.05 格式的时间节点。" 
        }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `读取失败: ${error.message}` }] };
    }
  }
  throw new Error("工具未找到");
});

// --- 3. 连接逻辑 ---
const transports = new Map();
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
  console.log("【2026.04.05 专用识别版】已上线");
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send("会话不存在");
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`服务启动，正在监听端口: ${port}`);
});