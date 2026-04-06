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
        { name: "notion-mcp-advanced", version: "2.0.0" },
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
                description: "【局部读取模式】读取最近 N 个时间节点内容。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } }, required: ["pageId"] }
            },
            {
                name: "read_database_rows",
                description: "传入数据库/表格的页面ID，返回数据库里所有行的内容（包含日期、步数等）。",
                inputSchema: { type: "object", properties: { pageId: { type: "string", description: "需要查询的数据库页面 ID" } }, required: ["pageId"] }
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

        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results;
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

        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({
                    database_id: args.pageId
                });

                if (response.results.length === 0) {
                    console.log("⚠️ 小克尝试读取表格，但该表格里没有任何数据。");
                    return { content: [{ type: "text", text: "该数据库里面完全没有任何数据行（是空的）。" }] };
                }

                let resultText = "【数据库所有行内容如下】\n";
                // 动态抓取所有列，不论列名是什么
                response.results.forEach((page, index) => {
                    resultText += `\n--- 第 ${index + 1} 行记录 ---\n`;
                    for (const key in page.properties) {
                        const p = page.properties[key];
                        let val = "空";
                        try {
                            if (p.type === 'title') val = p.title?.[0]?.plain_text || "空";
                            else if (p.type === 'rich_text') val = p.rich_text?.[0]?.plain_text || "空";
                            else if (p.type === 'number') val = p.number !== null ? p.number : "空";
                            else if (p.type === 'date') val = p.date?.start || "空";
                            else if (p.type === 'select') val = p.select?.name || "空";
                            else if (p.type === 'multi_select') val = p.multi_select?.map(x => x.name).join(', ') || "空";
                            else if (p.type === 'phone_number') val = p.phone_number || "空";
                            else if (p.type === 'checkbox') val = p.checkbox ? "是" : "否";
                            else if (p.type === 'status') val = p.status?.name || "空";
                            else val = `[系统格式:${p.type}]`;
                        } catch (e) {
                            val = "读取错误";
                        }
                        resultText += `[${key}]: ${val}\n`;
                    }
                });

                console.log(`✅ 成功读取了表格数据，共抓取到 ${response.results.length} 行，已发给小克！`);
                return { content: [{ type: "text", text: resultText }] };
            } catch (error) {
                console.log("❌ 读取失败:", error.message);
                return { content: [{ type: "text", text: `读取数据库失败: ${error.message}` }] };
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
    console.log(`\n================================`);
    console.log(`✅ 进阶 MCP 服务器已启动！`);
    console.log(`📡 端口: ${port}`);
    console.log(`🤖 等待小克发送请求... (请去 Msty 客户端跟小克对话)`);
    console.log(`================================\n`);
});