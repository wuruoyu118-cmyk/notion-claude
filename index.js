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
        { name: "notion-mcp-advanced", version: "2.2.0" },
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
                description: "【局部读取模式】读取最近 N 个时间节点内容。支持：2026.04.06、2026年4月6日、4月6日等多种格式。",
                inputSchema: { type: "object", properties: { pageId: { type: "string" }, nodeCount: { type: "number", default: 3 } }, required: ["pageId"] }
            },
            {
                name: "read_database_rows",
                description: "【表格模式】读取数据库/表格的所有行，自动识别各种日期格式的内容。",
                inputSchema: { type: "object", properties: { pageId: { type: "string", description: "需要查询的数据库 ID" } }, required: ["pageId"] }
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

        // --- 模式二：升级版局部读取（支持中文日期） ---
        if (name === "read_latest_time_nodes") {
            const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
            const allBlocks = response.results;
            
            // 🚀 这里是重点：支持 . / - 以及 年月日 等各种日期分隔符
            const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/; 
            
            let nodeIndices = [];
            for (let i = 0; i < allBlocks.length; i++) {
                const blockText = getTxt(allBlocks[i]);
                if (timePattern.test(blockText)) {
                    nodeIndices.push(i);
                }
            }
            const count = args.nodeCount || 3;
            let startPos = allBlocks.length > 30 ? allBlocks.length - 30 : 0;
            if (nodeIndices.length > 0) {
                startPos = nodeIndices[Math.max(0, nodeIndices.length - count)];
            }
            const sliceText = allBlocks.slice(startPos).map(b => getTxt(b)).filter(t => t.trim()).join('\n\n');
            return { content: [{ type: "text", text: sliceText }] };
        }

        // --- 模式三：数据库抓取（全自动识别） ---
        if (name === "read_database_rows") {
            try {
                const response = await notion.databases.query({ database_id: args.pageId });
                if (response.results.length === 0) {
                    return { content: [{ type: "text", text: "该数据库目前为空。" }] };
                }

                let resultText = "【数据库所有行内容如下】\n";
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
                        } catch (e) { val = "读取错误"; }
                        resultText += `[${key}]: ${val}\n`;
                    }
                });

                console.log(`✅ 已通过数据库模式读取到包含“${response.results.length}条记录”的数据！`);
                return { content: [{ type: "text", text: resultText