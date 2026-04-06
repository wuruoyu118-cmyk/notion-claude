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
        { name: "notion-mcp-advanced", version: "1.5.0" },
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
            },
            // 👇 这是咱们今晚新加的“表格读取”工具
            {
                name: "read_health_database",
                description: "【表格模式】专门用于读取健康日记表格，获取最近几天的睡眠、步数和生理期记录。",
                inputSchema: {
                    type: "object",
                    properties: { 
                        databaseId: { type: "string", description: "健康日记的表格 32 位 ID" },
                        limit: { type: "number", default: 7, description: "需要读取的最近天数，默认 7 天" }
                    },
                    // 为了方便，不强制要求每次都传 ID，我们在下面写了默认值
                    required: [] 
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
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            allBlocks = response.results;

            const timePattern = /\d{4}\.\d{2}\.\d{2}/; 
            let nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
            }

            const count = args.nodeCount || 3;
            let startPos = allBlocks.length > 30 ? allBlocks.length - 30 : 0;
            if (nodeIndices.length > 0) {
                startPos = nodeIndices[Math.max(0, nodeIndices.length - count)];
            }

            const sliceText = allBlocks.slice(startPos).map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: sliceText }] };
        }

        // 👇 【模式三：表格读取模式（健康日记专用）】
        if (name === "read_health_database") {
            // 这里已经帮你把刚跑通的那个表格 ID 默认填上了，小克即便不知道 ID 也能读
            const dbId = args?.databaseId || '70c361d3dd364c7e8daa2f34f4250e4c';
            const limit = args?.limit || 7;

            try {
                const response = await notion.databases.query({
                    database_id: dbId,
                    sorts: [{ property: '日期', direction: 'descending' }],
                    page_size: limit,
                });

                if (response.results.length === 0) {
                    return { content: [{ type: "text", text: "目前的健康记录是空的。" }] };
                }

                let claudeReadableText = "【近期健康状态记录】\n";
                response.results.forEach(page => {
                    const props = page.properties;
                    // 兼容 Title 格式和 Date 格式的日期
                    const dateStr = props['日期']?.title?.[0]?.plain_text || props['日期']?.date?.start || '未知日期';
                    const steps = props['步数']?.number || 0;
                    const sleep = props['睡眠时长']?.number || 0;
                    const period = props['生理期']?.rich_text?.[0]?.plain_text || '无';

                    claudeReadableText += `[${dateStr}] 睡眠：${sleep}小时 | 步数：${steps}步 | 生理期状态：${period}\n`;
                });

                return { content: [{ type: "text", text: claudeReadableText }] };
            } catch (error) {
                return { content: [{ type: "text", text: `读取健康表格失败: ${error.message} (请确认小克的集成已在 Notion 表格页面右上角的 Connections 中获得授权)` }] };
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
    console.log(`进阶三模服务器已启动，端口: ${port} (包含健康表格读取)`);
});