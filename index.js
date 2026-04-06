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

// 提取文字的通用函数（用于纯文本页面）
const getTxt = (b) => {
    const type = b.type;
    return b[type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
};

app.get("/mcp", async (req, res) => {
    const server = new Server(
        { name: "notion-mcp-ultimate", version: "2.5.0" },
        { capabilities: { tools: {} } }
    );

    // --- 1. 注册所有工具 ---
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "read_full_page_content",
                description: "【纯文本模式】读取普通页面的全部内容。适用于：日记、信箱等非表格页面。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
            },
            {
                name: "read_database_rows",
                description: "【表格模式】读取表格/数据库的所有行。适用于：健康日记表格，获取步数、睡眠等数据。",
                inputSchema: { type: "object", properties: { pageId: { type: "string", description: "表格的 ID" } }, required: ["pageId"] }
            }
        ]
    }));

    // --- 2. 实现逻辑 ---
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // 【逻辑一：读纯文本】
        if (name === "read_full_page_content") {
            let allBlocks = [];
            let cursor = undefined;
            do {
                const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
                allBlocks.push(...response.results);
                cursor = response.next_cursor;
            } while (cursor);
            const fullText = allBlocks.map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: fullText || "页面内容为空。" }] };
        }

        // 【逻辑二：读表格数据】—— 专门解决你担心的“看不见表格”问题
        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({
                    database_id: args.pageId,
                    sorts: [{ property: '日期', direction: 'descending' }] // 按日期从新到旧排
                });

                if (response.results.length === 0) return { content: [{ type: "text", text: "表格是空的。" }] };

                let resultText = "【发现表格数据如下】\n";
                response.results.forEach((page, i) => {
                    const p = page.properties;
                    // 自动抓取：日期、步数、睡眠时长、生理期（名字对上就能读）
                    const date = p['日期']?.title?.[0]?.plain_text || p['日期']?.date?.start || "空";
                    const steps = p['步数']?.number ?? "空";
                    const sleep = p['睡眠时长']?.number ?? "空";
                    const period = p['生理期']?.rich_text?.[0]?.plain_text || "空";

                    resultText += `[${date}] 步数:${steps} | 睡眠:${sleep}h | 生理期:${period}\n`;
                });
                return { content: [{ type: "text", text: resultText }] };
            } catch (e) {
                return { content: [{ type: "text", text: "表格读取失败，请确认这是个表格 ID 且已授权连接。" }] };
            }
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
    console.log(`✅ 全能服务器启动！端口: ${port}`);
});