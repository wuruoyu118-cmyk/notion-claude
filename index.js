import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 初始化 Notion 客户端（从环境变量读取）
const notionToken = process.env.NOTION_API_KEY;
const notion = new Client({ auth: notionToken });

// 用于管理不同连接的会话映射
const transportSessions = new Map();

// --- 核心路由：处理 MCP 连接 ---
app.get("/mcp", async (req, res) => {
    console.log("收到连接请求，正在初始化独立 Server 实例...");

    // 1. 每次连接创建独立 Server，防止 Already connected 报错
    const server = new Server(
        { name: "notion-mcp-final", version: "1.3.0" },
        { capabilities: { tools: {} } }
    );

    // 2. 注册工具定义
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "append_to_notion_page",
                description: "向指定 Notion 页面追加内容",
                inputSchema: {
                    type: "object",
                    properties: { 
                        pageId: { type: "string" }, 
                        content: { type: "string" } 
                    },
                    required: ["pageId", "content"]
                }
            },
            {
                name: "read_latest_time_nodes",
                description: "读取底部最近 N 个 2026.04.05 格式的时间节点内容",
                inputSchema: {
                    type: "object",
                    properties: { 
                        pageId: { type: "string" }, 
                        nodeCount: { type: "number", default: 3 } 
                    },
                    required: ["pageId"]
                }
            }
        ]
    }));

    // 3. 实现工具逻辑
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // 【写入逻辑】
        if (name === "append_to_notion_page") {
            await notion.blocks.children.append({
                block_id: args.pageId,
                children: [{ 
                    object: 'block', 
                    type: 'paragraph', 
                    paragraph: { rich_text: [{ type: 'text', text: { content: args.content } }] } 
                }]
            });
            return { content: [{ type: "text", text: "成功追加内容到 Notion。" }] };
        }

        // 【精准读取逻辑】
        if (name === "read_latest_time_nodes") {
            // 获取最近的 100 个块（通常足够覆盖 3 个日期）
            const response = await notion.blocks.children.list({ 
                block_id: args.pageId, 
                page_size: 100 
            });
            const blocks = response.results;
            
            const timePattern = /\d{4}\.\d{2}\.\d{2}/; // 识别 2026.04.05
            const getTxt = (b) => {
                const type = b.type;
                return b[type]?.rich_text?.map(rt => rt.plain_text).join('') || "";
            };

            // 寻找所有包含日期的 block 的索引
            let nodeIndices = [];
            for (let i = 0; i < blocks.length; i++) {
                if (timePattern.test(getTxt(blocks[i]))) {
                    nodeIndices.push(i);
                }
            }

            if (nodeIndices.length === 0) {
                return { content: [{ type: "text", text: "未发现日期格式的节点。" }] };
            }

            // 计算从倒数第 N 个日期开始切
            const count = args.nodeCount || 3;
            const startPos = nodeIndices[Math.max(0, nodeIndices.length - count)];
            
            // 拼装文字
            const textResult = blocks.slice(startPos)
                .map(b => getTxt(b))
                .filter(t => t.trim().length > 0)
                .join('\n\n');

            return { content: [{ type: "text", text: textResult }] };
        }
        
        throw new Error("Tool not found");
    });

    // 4. 建立传输通道
    const transport = new SSEServerTransport("/messages", res);
    transportSessions.set(transport.sessionId, transport);

    res.on("close", () => {
        transportSessions.delete(transport.sessionId);
    });

    await server.connect(transport);
});

// --- 处理消息 POST ---
app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transportSessions.get(sessionId);
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).send("Session Lost");
    }
});

app.listen(port, "0.0.0.0", () => {
    console.log(`MCP Server 最终版已在端口 ${port} 启动`);
});