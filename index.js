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
        { name: "notion-mcp-advanced", version: "2.3.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "append_to_notion_page",
                description: "向指定页面追加内容",
                inputSchema: { type: "object", properties: { pageId: { type: "string" }, content: { type: "string" } }, required: ["pageId", "content"] }
            },
            {
                name: "read_full_page_content",
                description: "【全读模式】读取页面的全部内容。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
            },
            {
                name: "read_latest_time_nodes",
                description: "【局部读取模式】支持各种日期格式：2026.04.06、2026年4月6日、4月6日等。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } }, required: ["pageId"] }
            },
            {
                name: "read_database_rows",
                description: "【表格模式】读取数据库 ID，返回所有行（包含日期、步数、睡眠、生理期）。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] }
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
            return { content: [{ type: "text", text: "已成功存入 Notion。" }] };
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
            return { content: [{ type: "text", text: fullText || "内容为空。" }] };
        }

        // --- 重点：这里升级了正则，支持多种日期格式 ---
        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results;
            
            // 这个正则可以识别：2026.04.06, 2026-04-06, 2026/04/06, 2026年4月6日, 4月6日
            const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
            
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

        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({ database_id: args.pageId });
                let resultText = "【数据库行内容】\n";
                response.results.forEach((page, i) => {
                    resultText += `\n条目 ${i+1}:\n`;
                    for (const key in page.properties) {
                        const p = page.properties[key];
                        let val = "空";
                        if (p.type === 'title') val = p.title?.[0]?.plain_text || "空";
                        else if (p.type === 'rich_text') val = p.rich_text?.[0]?.plain_text || "空";
                        else if (p.type === 'number') val = p.number ?? "空";
                        else if (p.type === 'date') val = p.date?.start || "空";
                        resultText += `[${key}]: ${val} `;
                    }
                });
                return { content: [{ type: "text", text: resultText }] };
            } catch (e) {
                return { content: [{ type: "text", text: "读表失败: " + e.message }] };
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
    console.log(`✅ 服务器启动成功！端口: ${port}`);
});