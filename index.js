import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

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
      description: "向指定的 Notion 页面追加内容",
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
      description: "【精准版】仅读取底部最近 N 个时间点（2026.04.05）的内容",
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

const getBlockText = (block) => {
  const type = block.type;
  const content = block[type];
  if (content && content.rich_text) {
    return content.rich_text.map(rt => rt.plain_text).join('');
  }
  return "";
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "append_to_notion_page") {
    try {
      await notion.blocks.children.append({
        block_id: args.pageId,
        children: [{
          object: 'block', type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] }
        }]
      });
      return { content: [{ type: "text", text: `成功写进 Notion 底部。` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `写入失败: ${error.message}` }] };
    }
  }

  if (name === "read_latest_time_nodes") {
    try {
      let allBlocks = [];
      let cursor = undefined;

      // 1. 快速定位到底部（最多追溯最近 200 个块，通常覆盖小说最近几章足够了）
      let fetchCount = 0;
      do {
        const response = await notion.blocks.children.list({
          block_id: args.pageId,
          start_cursor: cursor,
          page_size: 100
        });
        allBlocks.push(...response.results);
        cursor = response.next_cursor;
        fetchCount++;
      } while (cursor && fetchCount < 2);

      const timePattern = /\d{4}\.\d{2}\.\d{2}/; 
      let nodeIndices = [];

      // 2. 找到所有时间节点的位置
      for (let i = 0; i < allBlocks.length; i++) {
        if (timePattern.test(getBlockText(allBlocks[i]))) {
          nodeIndices.push(i);
        }
      }

      // 3. 【核心修复】：只截取最后 N 个节点开始的部分
      const targetCount = args.nodeCount || 3;
      if (nodeIndices.length === 0) {
        return { content: [{ type: "text", text: "页面中没有找到 2026.04.05 格式的时间点。" }] };
      }

      // 确定起始位置：如果节点够多，就从倒数第 N 个节点开始切；不够多就从第 1 个开始
      const startIndex = nodeIndices[Math.max(0, nodeIndices.length - targetCount)];
      
      // 4. 只把这一小段转换成文字
      const resultText = allBlocks.slice(startIndex)
        .map(b => getBlockText(b))
        .filter(t => t.trim().length > 0)
        .join('\n\n');

      return {
        content: [{ 
          type: "text", 
          text: `【已为你读取底部最近的 ${targetCount} 个时间点内容】：\n\n${resultText}` 
        }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `读取失败: ${error.message}` }] };
    }
  }
  throw new Error("工具未找到");
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
  if (!transport) return res.status(404).send("会话不存在");
  await transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`精准读取服务器运行中...`);
});