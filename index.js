先替换 index.js 为下面内容（整份复制粘贴）：
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
if (!notionToken) {
console.error("❌ 缺少环境变量 NOTION_API_KEY");
}
const notion = new Client({ auth: notionToken });
const transportSessions = new Map();
const getTxt = (b) => {
const type = b?.type;
if (!type) return "";
const rt = b?.[type]?.rich_text;
if (!Array.isArray(rt)) return "";
return rt.map((x) => x?.plain_text || "").join("");
};
app.get("/mcp", async (req, res) => {
const server = new Server(
{ name: "notion-mcp-advanced", version: "2.5.1" },
{ capabilities: { tools: {} } }
);
// 1) 注册工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
tools: [
{
name: "read_full_page_content",
description: "【文本模式】读取普通页面的全部纯文本内容。",
inputSchema: {
type: "object",
properties: { pageId: { type: "string" } },
required: ["pageId"],
},
},
{
name: "read_latest_time_nodes",
description: "【日记模式】识别日期文本并截取最近内容（读页面 blocks，不读数据库）。",
inputSchema: {
type: "object",
properties: {
pageId: { type: "string" },
nodeCount: { type: "number", default: 3 },
},
required: ["pageId"],
},
},
{
name: "read_database_rows",
description: "【表格模式】读取 Notion 数据库行（必须传 databaseId）。返回：日期(标题列)、步数、睡眠时长、生理期。",
inputSchema: {
type: "object",
properties: { databaseId: { type: "string" } },
required: ["databaseId"],
},
},
],
}));
// 2) 工具逻辑
server.setRequestHandler(CallToolRequestSchema, async (request) => {
const { name, arguments: args } = request.params;
// 纯文本读取页面
if (name === "read_full_page_content") {
let allBlocks = [];
let cursor = undefined;
do {
const response = await notion.blocks.children.list({
block_id: args.pageId,
start_cursor: cursor,
});
allBlocks.push(...response.results);
cursor = response.next_cursor;
} while (cursor);
const text = allBlocks.map(getTxt).filter((t) => t.trim()).join("nn");
return { content: [{ type: "text", text: text || "内容为空。" }] };
}
// 日记模式：从页面 blocks 里找日期文本，截取最近一段
if (name === "read_latest_time_nodes") {
const response = await notion.blocks.children.list({
block_id: args.pageId,
page_size: 100,
});
const allBlocks = response.results || [];
// 支持：2026.04.06 / 2026-04-06 / 2026/04/06 / 2026年4月6日 / 4月6日
const timePattern =
/(d{4}[-./年]d{1,2}[-./月]d{1,2}日?)|(d{1,2}月d{1,2}日)/;
const nodeIndices = [];
for (let i = 0; i < allBlocks.length; i++) {
if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
}
const count = args.nodeCount || 3;
const startPos =
nodeIndices.length > 0 ? nodeIndices[Math.max(0, nodeIndices.length - count)] : 0;
const text = allBlocks.slice(startPos).map(getTxt).filter((t) => t.trim()).join("nn");
return { content: [{ type: "text", text: text || "内容为空。" }] };
}
// 数据库读取（结构化）
if (name === "read_database_rows") {
try {
const response = await notion.databases.query({
database_id: args.databaseId,
sorts: [{ property: "日期", direction: "descending" }],
});
let resultText = "【数据库行内容】";
const rows = response.results || [];
rows.forEach((page, i) => {
const p = page.properties || {};
// 你的「日期」是标题列（title）
const date =
p["日期"]?.title?.map((t) => t.plain_text).join("") || "未记录";
const steps = p["步数"]?.number ?? "未记录";
const sleep = p["睡眠时长"]?.number ?? "未记录";
// 你的「生理期」是 text（API 里是 rich_text）
const period =
p["生理期"]?.rich_text?.map((t) => t.plain_text).join("") || "无";
resultText += \n[记录${i + 1}] 日期: ${date} | 步数: ${steps} | 睡眠: ${sleep}小时 | 生理期: ${period};
});
if (rows.length === 0) resultText += "n（当前数据库没有任何记录）";
return { content: [{ type: "text", text: resultText }] };
} catch (e) {
const details =
e?.body ? JSON.stringify(e.body) :
e?.response?.data ? JSON.stringify(e.response.data) :
e?.message || String(e);
return {
content: [
{
type: "text",
text:
"读取表格失败。请确认：n1) 传入的是 databaseId（例如 70c361d3dd364c7e8daa2f34f4250e4c）n2) NOTION_API_KEY 对应的 integration 已被 Share 进该数据库。n错误信息: " +
details,
},
],
};
}
}
throw new Error("Unknown tool: " + name);
});
const transport = new SSEServerTransport("/messages", res);
transportSessions.set(transport.sessionId, transport);
res.on("close", () => transportSessions.delete(transport.sessionId));
await server.connect(transport);
});
// MCP SSE 需要的消息通道
app.post("/messages", async (req, res) => {
const sessionId = req.query.sessionId;
const transport = transportSessions.get(sessionId);
if (transport) await transport.handlePostMessage(req, res);
else res.status(404).send("Session Lost");
});
app.listen(port, "0.0.0.0", () => {
console.log(✅ 服务器启动成功！端口: ${port});
});