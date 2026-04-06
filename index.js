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

const getTxt = (b) => {
    const type = b?.type;
    if (!type) return "";
    const rt = b[type]?.rich_text;
    return rt?.map(rt => rt.plain_text).join('') || "";
};

app.get("/mcp", async (req, res) => {
    const server = new Server(
        { name: "notion-mcp-simple", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    // --- 注册三个最稳的纯文本工具 ---
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "append_to_notion_page",
                description: "【追加模式】直接往页面末尾写一行话。",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" }, content: { type: "string" } },
                    required: ["pageId", "content"]
                }
            },
            {
                name: "read_full_page_content",
                description: "【全读模式】读取页面的全部纯文本。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
            },
            {
                name: "read_latest_time_nodes",
                description: "【日记模式】按日期切片读取最近内容（支持2026.04.06、2026年4月6日等格式）。",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } },
                    required: ["pageId"]
                }
            }
        ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === "append_to_notion_page") {
            await notion.blocks.children.append({
                block_id: args.pageId,
                children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] } }]
            });
            return { content: [{ type: "text", text: "已成功写入页面。" }] };
        }

        if (name === "read_full_page_content") {
            let allBlocks = [];
            let cursor = undefined;
            do {
                const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
                allBlocks.push(...response.results);
                cursor = response.next_cursor;
            } while (cursor);
            const fullText = allBlocks.map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: fullText || "页面是空的。" }] };
        }

        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results;
            // 智能日期正则
            const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
            let nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
            }
            const count = args.nodeCount || 3;
            let startPos = nodeIndices.length > 0 ? nodeIndices[Math.max(0, nodeIndices.length - count)] : 0;
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
    console.log(`✅ 纯文本服务器恢复成功！端口: ${port}`);
});