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
                description: "【全读模式】读取页面的全部内容。适用于普通纯文本页面。",
                inputSchema: {
                    type: "object",
                    properties: { pageId: { type: "string" } },
                    required: ["pageId"]
                }
            },
            {
                name: "read_latest_time_nodes",
                description: "【局部读取模式】从底部向上读取最近 N 个时间节点内容。适用于信箱、日记等。",
                inputSchema: {
                    type: "object",
                    properties: { 
                        pageId: { type: "string" }, 
                        nodeCount: { type: "number", default: 3 } 
                    },
                    required: ["pageId"]
                }
            },
            // 👇 这是按总监要求新增的工具
            {
                name: "read_database_rows",
                description: "传入数据库/表格的页面ID，返回数据库里所有行的内容（包含日期、步数、睡眠、生理期等字段）。",
                inputSchema: {
                    type: "object",
                    properties: { 
                        pageId: { type: "string", description: "需要查询的数据库页面 ID (Database ID)" } 
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

        // 👇 【按总监要求的数据库读取模式】
        if (name === "read_database_rows") {
            try {
                // 使用总监传进来的 pageId 去查询表格
                const response = await notion.databases.query({
                    database_id: args.pageId,
                    // 默认按日期排个序，让小克先看到最新的
                    sorts: [{ property: '日期', direction: 'descending' }]
                });

                if (response.results.length === 0) {
                    return { content: [{ type: "text", text: "该数据库目前为空或没有读取到数据。" }] };
                }

                let resultText = "【数据库行内容如下】\n";
                
                response.results.forEach(page => {
                    const props = page.properties;
                    // 动态抓取字段，如果某一天没填也不会报错
                    const dateStr = props['日期']?.title?.[0]?.plain_text || props['日期']?.date?.start || '空';
                    const steps = props['步数']?.number || 0;
                    const sleep = props['睡眠时长']?.number || 0;
                    const period = props['生理期']?.rich_text?.[0]?.plain_text || '空';

                    resultText += `日期: ${dateStr} | 步数: ${steps} | 睡眠时长: ${sleep} | 生理期: ${period}\n`;
                });

                return { content: [{ type: "text", text: resultText }] };
            } catch (error) {
                return { content: [{ type: "text", text: `读取数据库失败: ${error.message} (请检查 ID 是否正确，且小克是否获得了该页面的 Connections 授权)` }] };
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
    console.log(`进阶服务器已启动，端口: ${port} (已加入传入 pageId 读取所有行的工具)`);
});