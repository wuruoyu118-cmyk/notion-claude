import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;
const transportSessions = new Map();

// ── Notion ────────────────────────────────────────────────────────────────────

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const getTxt = (b) => {
  const type = b?.type;
  if (!type) return "";
  const rt = b[type]?.rich_text;
  return rt?.map((rt) => rt.plain_text).join("") || "";
};

// ── Gmail ─────────────────────────────────────────────────────────────────────

function getGmailService() {
  const tokenPath = path.join(__dirname, "token.json");
  const tokenData = JSON.parse(readFileSync(tokenPath, "utf-8"));

  const oauth2Client = new google.auth.OAuth2(
    tokenData.client_id,
    tokenData.client_secret,
    tokenData.token_uri
  );

  oauth2Client.setCredentials({
    access_token: tokenData.token,
    refresh_token: tokenData.refresh_token,
    expiry_date: tokenData.expiry ? new Date(tokenData.expiry).getTime() : undefined,
  });

  oauth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      tokenData.token = tokens.access_token;
      if (tokens.expiry_date) {
        tokenData.expiry = new Date(tokens.expiry_date).toISOString();
      }
      writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
    }
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

function decodeBody(payload) {
  if (payload.mimeType === "text/plain") {
    const data = payload.body?.data;
    if (data) return Buffer.from(data, "base64url").toString("utf-8");
  }
  if (payload.mimeType?.startsWith("multipart/")) {
    for (const part of payload.parts || []) {
      const result = decodeBody(part);
      if (result) return result;
    }
  }
  return "";
}

function buildRaw(to, subject, body, extra = {}) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(extra.inReplyTo ? [`In-Reply-To: ${extra.inReplyTo}`] : []),
    ...(extra.references ? [`References: ${extra.references}`] : []),
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

app.get("/mcp", async (req, res) => {
  const server = new Server(
    { name: "notion-gmail-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // Notion tools
      {
        name: "append_to_notion_page",
        description: "【追加模式】直接往页面末尾写一行话。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            content: { type: "string" },
          },
          required: ["pageId", "content"],
        },
      },
      {
        name: "read_full_page_content",
        description: "【全读模式】读取页面的全部纯文本。",
        inputSchema: {
          type: "object",
          properties: { pageId: { type: "string" } },
          required: ["pageId"],
        },
      },
      {
        name: "read_latest_time_nodes",
        description: "【日记模式】按日期切片读取最近内容（支持2026.04.06、2026年4月6日等格式）。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            nodeCount: { type: "number", default: 3 },
          },
          required: ["pageId"],
        },
      },
      // Gmail tools
      {
        name: "search_emails",
        description: "搜索邮件，返回发件人、主题、日期、摘要",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail搜索语法，如 'is:unread' 或 'from:xxx@gmail.com'" },
            max_results: { type: "number", default: 5 },
          },
          required: ["query"],
        },
      },
      {
        name: "get_email",
        description: "读取单封邮件的完整正文",
        inputSchema: {
          type: "object",
          properties: {
            message_id: { type: "string" },
          },
          required: ["message_id"],
        },
      },
      {
        name: "send_email",
        description: "发送新邮件",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "reply_email",
        description: "回复某封邮件",
        inputSchema: {
          type: "object",
          properties: {
            message_id: { type: "string" },
            body: { type: "string" },
          },
          required: ["message_id", "body"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Notion
    if (name === "append_to_notion_page") {
      await notion.blocks.children.append({
        block_id: args.pageId,
        children: [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: args.content } }] },
        }],
      });
      return { content: [{ type: "text", text: "已成功写入页面。" }] };
    }

    if (name === "read_full_page_content") {
      let allBlocks = [];
      let cursor = undefined;
      do {
        const response = await notion.blocks.children.list({ block_id: args.pageId, start_cursor: cursor });
        allBlocks.push(...response.results);
        cursor = response.next_cursor;
      } while (cursor);
      const fullText = allBlocks.map((b) => getTxt(b)).filter((t) => t.trim()).join("\n\n");
      return { content: [{ type: "text", text: fullText || "页面是空的。" }] };
    }

    if (name === "read_latest_time_nodes") {
      const response = await notion.blocks.children.list({ block_id: args.pageId, page_size: 100 });
      const allBlocks = response.results;
      const timePattern = /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
      let nodeIndices = [];
      for (let i = 0; i < allBlocks.length; i++) {
        if (timePattern.test(getTxt(allBlocks[i]))) nodeIndices.push(i);
      }
      const count = args.nodeCount || 3;
      let startPos = nodeIndices.length > 0 ? nodeIndices[Math.max(0, nodeIndices.length - count)] : 0;
      const sliceText = allBlocks.slice(startPos).map((b) => getTxt(b)).filter((t) => t.trim()).join("\n\n");
      return { content: [{ type: "text", text: sliceText }] };
    }

    // Gmail
    if (name === "search_emails") {
      const gmail = getGmailService();
      const result = await gmail.users.messages.list({
        userId: "me",
        q: args.query,
        maxResults: args.max_results || 5,
      });
      const messages = result.data.messages || [];
      if (!messages.length) return { content: [{ type: "text", text: "没有找到匹配的邮件。" }] };

      const lines = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const h = Object.fromEntries(detail.data.payload.headers.map((h) => [h.name, h.value]));
          return `ID: ${msg.id}\n发件人: ${h.From || "未知"}\n主题: ${h.Subject || "无主题"}\n日期: ${h.Date || "未知"}\n摘要: ${(detail.data.snippet || "").slice(0, 120)}\n${"─".repeat(40)}`;
        })
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (name === "get_email") {
      const gmail = getGmailService();
      const detail = await gmail.users.messages.get({ userId: "me", id: args.message_id, format: "full" });
      const h = Object.fromEntries(detail.data.payload.headers.map((h) => [h.name, h.value]));
      const body = decodeBody(detail.data.payload) || detail.data.snippet || "（无法提取正文）";
      return {
        content: [{
          type: "text",
          text: `发件人: ${h.From || "未知"}\n主题: ${h.Subject || "无主题"}\n日期: ${h.Date || "未知"}\n\n${body}`,
        }],
      };
    }

    if (name === "send_email") {
      const gmail = getGmailService();
      const raw = buildRaw(args.to, args.subject, args.body);
      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return { content: [{ type: "text", text: `邮件已发送至 ${args.to}` }] };
    }

    if (name === "reply_email") {
      const gmail = getGmailService();
      const original = await gmail.users.messages.get({
        userId: "me",
        id: args.message_id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Message-ID", "References"],
      });
      const h = Object.fromEntries(original.data.payload.headers.map((h) => [h.name, h.value]));
      const threadId = original.data.threadId;
      const subject = h.Subject?.toLowerCase().startsWith("re:") ? h.Subject : `Re: ${h.Subject || ""}`;
      const raw = buildRaw(h.From || "", subject, args.body, {
        inReplyTo: h["Message-ID"],
        references: `${h.References || ""} ${h["Message-ID"] || ""}`.trim(),
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
      return { content: [{ type: "text", text: `已回复邮件：${subject}` }] };
    }

    throw new Error(`未知工具: ${name}`);
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
  else res.status(404).send("Session not found");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Notion + Gmail MCP 启动成功，端口: ${port}`);
});
