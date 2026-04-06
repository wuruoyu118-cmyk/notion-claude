import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;

const notionToken = process.env.NOTION_API_KEY;
const notion = new Client({ auth: notionToken });
const transportSessions = new Map();

// 提取文字的通用工具函数
const getTxt = (b) => {
    const type = b?.type;
    if (!type) return "";
    const rt = b?.[type]?.rich_text;
    if (!Array.isArray(rt)) return "";
    return rt.map((x) => x?.plain_text || "").join("");
};

app.get("/mcp", async (req, res) => {
    const server = new Server(
        { name: "notion-mcp-final", version: "3.0.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "read_full_page_content",
                description: "【文本模式】读取普通页面的纯文本。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
            },
            {
                name: "read_latest_time_nodes",
                description: "【日记模式】识别各种日期前缀并读取最近内容。",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } },
                    required: ["pageId"],
                },
            },
            {
                name: "read_database_rows",
                description: "【表格模式】专门读取表格数据（日期、步数、睡眠、生理期）。",
                inputSchema: { type: "object", properties: { databaseId: { type: "string" } }, required: ["databaseId"] },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === "read_full_page_content") {
            let allBlocks = [];
            let cursor = undefined;
            do {
                const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
                allBlocks.push(...response.results);
                cursor = response.next_cursor;
            } while (cursor);
            const text = allBlocks.map(getTxt).filter((t) => t.trim()).join("\n\n");
            return { content: [{ type: "text", text: text || "内容为空。" }] };
        }

        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results || [];
            // 修复后的正则：支持 2026年4月6日 这种中文格式
            const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
            const nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
            }
            const count = args.nodeCount || 3;
            const startPos = nodeIndices.length > 0 ? nodeIndices[Math.max(0, nodeIndices.length - count)] : 0;
            const text = allBlocks.slice(startPos).map(getTxt).filter((t) => t.trim()).join("\n\n");
            return { content: [{ type: "text", text: text || "内容为空。" }] };
        }

        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({
                    database_id: args.databaseId,
                    sorts: [{ property: "日期", direction: "descending" }],
                });
                let resultText = "【找到表格记录】";
                const rows = response.results || [];
                rows.forEach((page, i) => {
                    const p = page.properties || {};
                    const date = p["日期"]?.title?.map((t) => t.plain_text).join("") || p["日期"]?.date?.start || "未记录";
                    const steps = p["步数"]?.number ?? "未记录";
                    const sleep = p["睡眠时长"]?.number ?? "未记录";
                    const period = p["生理期"]?.rich_text?.map((t) => t.plain_text).join("") || "无";
                    resultText += `\n[${i + 1}] 日期: ${date} | 步数: ${steps} | 睡眠: ${sleep}小时 | 生理期: ${period}`;
                });
                if (rows.length === 0) resultText += "\n（当前数据库没有任何记录）";
                return { content: [{ type: "text", text: resultText }] };
            } catch (e) {
                return { content: [{ type: "text", text: "读取表格失败: " + (e.message || "未知错误") }] };
            }
        }
        throw new Error("Unknown tool: " + name);
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
    console.log(`✅ 服务器已启动！(奥克兰凌晨版) 端口: ${port}`);
});