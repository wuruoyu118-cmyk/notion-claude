import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

const notionToken = process.env.NOTION_API_KEY;
const notion = new Client({ auth: notionToken });
const transportSessions = new Map();

// 提取文字的通用工具函数
const getTxt = (b) => {
    const type = b.type;
    return b[type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
};

app.get("/mcp", async (req, res) => {
    const server = new Server(
        { name: "notion-mcp-advanced", version: "1.4.0" },
        { capabilities: { tools: {} } }
    );

    // --- 1. 注册工具 ---
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "append_to_notion_page",
                description: "向指定页面追加内容（适用于写回信、存入库）",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" }, content: { type: "string" } },
                    required: ["pageId", "content"]
                }
            },
            {
                name: "read_full_page_content",
                description: "【全读模式】读取页面的全部内容。适用于：输入库、小默契、歌单、情侣清单。",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" } },
                    required: ["pageId"]
                }
            },
            {
                name: "read_latest_time_nodes",
                description: "【局部读取模式】从底部向上读取最近 N 个 2026.04.05 格式的时间节点内容。适用于：信箱、日记、记忆库。",
                inputSchema: {
                    type: "object",
                    properties: { 
                        pageId: { type: "string" }, 
                        nodeCount: { type: "number", default: 3, description: "需要读取的时间节点数量" } 
                    },
                    required: ["pageId"]
                }
            }
        ]
    }));

    // --- 2. 工具逻辑实现 ---
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // 【追加写入】
        if (name === "append_to_notion_page") {
            await notion.blocks.children.append({
                block_id: args.pageId,
                children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] } }]
            });
            return { content: [{ type: "text", text: "已成功存入 Notion。" }] };
        }

        // 【模式一：全读模式】
        if (name === "read_full_page_content") {
            let allBlocks = [];
            let cursor = undefined;
            // 循环翻页，确保读到大模块里的所有内容（最多支持1000个block，防止内存溢出）
            let loop = 0;
            do {
                const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
                allBlocks.push(...response.results);
                cursor = response.next_cursor;
                loop++;
            } while (cursor && loop < 10);

            const fullText = allBlocks.map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: fullText || "页面内容为空。" }] };
        }

        // 【模式二：时间节点局部读】
        if (name === "read_latest_time_nodes") {
            let allBlocks = [];
            let cursor = undefined;
            // 优先抓取底部内容
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            allBlocks = response.results;

            const timePattern = /\d{4}\.\d{2}\.\d{2}/; 
            let nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
            }

            const count = args.nodeCount || 3;
            // 如果没找到日期，保底读最后 30 行；找到了，就从倒数第 N 个日期开始切
            let startPos = allBlocks.length > 30 ? allBlocks.length - 30 : 0;
            if (nodeIndices.length > 0) {
                startPos = nodeIndices[Math.max(0, nodeIndices.length - count)];
            }

            const sliceText = allBlocks.slice(startPos).map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: sliceText }] };
        }

        throw new Error("Unknown tool");
    });

    const transport = new SSEServerTransport("/messages", res);
    transportSessions.set(transport.sessionId, transport);
    res.on("close", () => transportSessions.delete(transport.sessionId));
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transportSessions.get(sessionId);
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(404).send("Session Lost");
});

app.listen(port, "0.0.0.0", () => {
    console.log(`进阶双模服务器已启动，端口: ${port}`);
});