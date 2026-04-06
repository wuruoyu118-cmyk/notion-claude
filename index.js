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
    const type = b.type;
    return b[type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
};

app.get("/mcp", async (req, res) => {
    const server = new Server(
        { name: "notion-mcp-advanced", version: "2.5.0" },
        { capabilities: { tools: {} } }
    );

    // --- 1. 注册工具 ---
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "read_full_page_content",
                description: "【文本模式】读取普通页面的全部纯文本内容。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
            },
            {
                name: "read_latest_time_nodes",
                description: "【日记模式】识别各种日期格式（如2026.04.06或2026年4月6日）并截取最近内容。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } }, required: ["pageId"] }
            },
            {
                name: "read_database_rows",
                description: "【表格模式】专门读取 Notion 表格数据（日期、步数、睡眠、生理期等）。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
            }
        ]
    }));

    // --- 2. 逻辑实现 ---
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // 模式：纯文本读取
        if (name === "read_full_page_content") {
            let allBlocks = [];
            let cursor = undefined;
            do {
                const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
                allBlocks.push(...response.results);
                cursor = response.next_cursor;
            } while (cursor);
            return { content: [{ type: "text", text: allBlocks.map(b => getTxt(b)).join('\n\n') }] };
        }

        // 模式：带日期识别的局部读取（针对总监提到的日期格式问题）
        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results;
            // 升级版正则：支持 . / - 和 年月日
            const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
            let nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
            }
            const count = args.nodeCount || 3;
            let startPos = nodeIndices.length > 0 ? nodeIndices[Math.max(0, nodeIndices.length - count)] : 0;
            return { content: [{ type: "text", text: allBlocks.slice(startPos).map(b => getTxt(b)).join('\n\n') }] };
        }

        // 🚀 核心新增：表格专用读取工具
        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({
                    database_id: args.pageId,
                    sorts: [{ property: '日期', direction: 'descending' }]
                });

                let resultText = "【发现健康日记表格数据】\n";
                response.results.forEach((page, i) => {
                    const p = page.properties;
                    // 自动兼容各种列名和类型
                    const date = p['日期']?.title?.[0]?.plain_text || p['日期']?.date?.start || "未知日期";
                    const steps = p['步数']?.number ?? "未记录";
                    const sleep = p['睡眠时长']?.number ?? "未记录";
                    const period = p['生理期']?.rich_text?.[0]?.plain_text || "无";
                    
                    resultText += `\n[记录${i+1}] 日期: ${date} | 步数: ${steps} | 睡眠: ${sleep}小时 | 生理期: ${period}`;
                });
                return { content: [{ type: "text", text: resultText }] };
            } catch (e) {
                return { content: [{ type: "text", text: "读取表格失败，请确认该 ID 是表格 ID 而不是页面 ID。错误: " + e.message }] };
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
    console.log(`✅ 终极版服务器已启动！端口: ${port}`);
});