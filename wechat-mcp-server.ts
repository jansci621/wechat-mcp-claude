#!/usr/bin/env bun
/**
 * WeChat MCP Server - Claude Code 微信工具集成
 *
 * 通过 MCP 协议让 Claude Code 直接与微信交互。
 * 收到消息后自动调用 Claude CLI 处理并回复。
 *
 * 使用方式:
 *   在 .mcp.json 中配置:
 *   {
 *     "mcpServers": {
 *       "wechat-bridge": {
 *         "command": "bun",
 *         "args": ["./wechat-mcp-server.ts"]
 *       }
 *     }
 *   }
 *
 * MCP 工具:
 *   - wechat_send: 发送微信消息
 *   - wechat_poll: 获取待处理的微信消息
 *   - wechat_status: 获取连接状态
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// MCP SDK 导入
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── 配置 ────────────────────────────────────────────────────────────────────

const BRIDGE_VERSION = "1.1.0";
const CLAUDE_DIR = path.join(process.env.HOME || "~", ".claude");
const CREDENTIALS_DIR = path.join(CLAUDE_DIR, "channels", "wechat");

// 支持多账号：通过环境变量指定账号
// WECHAT_ACCOUNT_FILE: 账号文件路径（如 ~/.claude/channels/wechat/accounts/bot1.json）
// WECHAT_ACCOUNT_NAME: 账号名称（用于日志区分，默认 "default"）
function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || "", p.slice(2));
  }
  return p;
}

const ACCOUNT_NAME = process.env.WECHAT_ACCOUNT_NAME || "default";
const CREDENTIALS_FILE = process.env.WECHAT_ACCOUNT_FILE
  ? expandTilde(process.env.WECHAT_ACCOUNT_FILE)
  : path.join(CREDENTIALS_DIR, "accounts", `${ACCOUNT_NAME}.json`);

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MCP_SERVER_NAME = "wechat-bridge";
const MCP_SERVER_VERSION = "1.3.0";

// ── 日志 ────────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[wechat] ${msg}`);
}

function logError(msg: string) {
  console.error(`[wechat] ERROR: ${msg}`);
}

// MCP 模式日志（输出到 stderr，带时间戳和账号标识）
function mcpLog(msg: string) {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
  const accountLabel = ACCOUNT_NAME === "default" ? "" : `[${ACCOUNT_NAME}] `;
  process.stderr.write(`[${time}] ${accountLabel}${msg}\n`);
}

// ── 账户管理 ────────────────────────────────────────────────────────────────

interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// 扫描并加载所有已配置的账号
function loadAllAccounts(): { name: string; data: AccountData }[] {
  const accountsDir = path.join(CREDENTIALS_DIR, "accounts");
  const accounts: { name: string; data: AccountData }[] = [];

  // 优先检查环境变量指定的账号
  if (process.env.WECHAT_ACCOUNT_FILE || process.env.WECHAT_ACCOUNT_NAME) {
    const account = loadCredentials();
    if (account) {
      return [{ name: ACCOUNT_NAME, data: account }];
    }
    return [];
  }

  // 扫描 accounts 目录
  if (!fs.existsSync(accountsDir)) {
    // 兼容旧的单账号路径
    const legacyFile = path.join(CREDENTIALS_DIR, "account.json");
    if (fs.existsSync(legacyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyFile, "utf-8"));
        return [{ name: "default", data }];
      } catch {
        // ignore
      }
    }
    return [];
  }

  for (const file of fs.readdirSync(accountsDir)) {
    if (file.endsWith(".json")) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(accountsDir, file), "utf-8"));
        accounts.push({
          name: file.replace(".json", ""),
          data,
        });
      } catch {
        // ignore
      }
    }
  }

  return accounts;
}

function saveCredentials(data: AccountData): void {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

// ── 微信 API ────────────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/")
    ? params.baseUrl
    : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── 微信消息类型 ────────────────────────────────────────────────────────────

interface TextItem {
  text?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  ref_msg?: RefMessage;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

const MSG_TYPE_USER = 1;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

// ── getUpdates / sendMessage ────────────────────────────────────────────────

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: BRIDGE_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `wechat-mcp:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const clientId = generateClientId();
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: BRIDGE_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  return clientId;
}

// ── Context Token 缓存 ───────────────────────────────────────────────────────

const contextTokenCache = new Map<string, string>();

function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, token);
}

function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId);
}

// ── 会话上下文管理 ──────────────────────────────────────────────────────────

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  isSummary?: boolean; // 标记是否为压缩摘要
}

const MAX_HISTORY_LENGTH = 20; // 最多保留 20 条历史
const MAX_MESSAGE_LENGTH = 2000; // 单条消息最大长度
const MAX_CONTEXT_TOKENS = 50000; // 上下文 token 阈值
const TOKEN_RATIO = 2; // 字符/token 估算比例（中文约 2 字符/token）

// 按 accountName:senderId 存储会话历史
const conversationHistory = new Map<string, ConversationMessage[]>();

function getConversationKey(accountName: string, senderId: string): string {
  return `${accountName}:${senderId}`;
}

/**
 * 估算 token 数量（粗略估算）
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_RATIO);
}

/**
 * 估算历史记录总 token 数
 */
function estimateHistoryTokens(history: ConversationMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * 摘要长消息：保留开头和结尾，中间省略
 */
function summarizeMessage(content: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  if (content.length <= maxLength) {
    return content;
  }

  const halfLength = Math.floor(maxLength / 2);
  const head = content.slice(0, halfLength);
  const tail = content.slice(-halfLength);
  const omittedLength = content.length - maxLength;

  return `${head}\n\n... [已省略 ${omittedLength} 字符] ...\n\n${tail}`;
}

/**
 * 使用 Claude 压缩历史记录
 */
async function compressHistory(history: ConversationMessage[]): Promise<string> {
  const historyText = history
    .map(m => {
      const roleLabel = m.role === "user" ? "用户" : "助手";
      return `[${roleLabel}] ${m.content}`;
    })
    .join("\n\n");

  const compressPrompt = `请将以下对话历史压缩为简洁的摘要，保留关键信息和上下文要点。用中文回复，控制在 500 字以内。

对话历史：
${historyText}

摘要：`;

  const result = Bun.spawnSync({
    cmd: ["claude", "-p", compressPrompt, "--dangerously-skip-permissions"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000, // 30 秒超时
  });

  if (result.exitCode === 0) {
    return result.stdout.toString().trim();
  }

  // 压缩失败，返回简单的截断摘要
  return `[历史摘要] 共 ${history.length} 条消息，前几条：\n${history.slice(0, 3).map(m => m.content.slice(0, 100)).join("\n")}`;
}

/**
 * 检查并压缩历史记录
 */
async function checkAndCompressHistory(
  accountName: string,
  senderId: string,
  log: (msg: string) => void
): Promise<void> {
  const key = getConversationKey(accountName, senderId);
  const history = conversationHistory.get(key);
  if (!history || history.length < 5) return; // 少于 5 条不压缩

  const tokens = estimateHistoryTokens(history);
  if (tokens > MAX_CONTEXT_TOKENS) {
    log(`📦 上下文超限 (${tokens} tokens)，正在压缩...`);

    // 保留最近 3 条消息，压缩其余的
    const recentMessages = history.slice(-3);
    const oldMessages = history.slice(0, -3);

    if (oldMessages.length > 0) {
      const summary = await compressHistory(oldMessages);

      // 用摘要替换旧消息
      const compressedHistory: ConversationMessage[] = [
        {
          role: "assistant",
          content: `[历史摘要]\n${summary}`,
          timestamp: oldMessages[0].timestamp,
          isSummary: true,
        },
        ...recentMessages,
      ];

      conversationHistory.set(key, compressedHistory);
      const newTokens = estimateHistoryTokens(compressedHistory);
      log(`✅ 压缩完成: ${tokens} → ${newTokens} tokens`);
    }
  }
}

function addToConversation(
  accountName: string,
  senderId: string,
  role: "user" | "assistant",
  content: string
): void {
  const key = getConversationKey(accountName, senderId);
  if (!conversationHistory.has(key)) {
    conversationHistory.set(key, []);
  }

  const history = conversationHistory.get(key)!;

  // 摘要长消息
  const summarizedContent = summarizeMessage(content);

  history.push({
    role,
    content: summarizedContent,
    timestamp: Date.now(),
  });

  // 限制历史长度
  if (history.length > MAX_HISTORY_LENGTH) {
    history.splice(0, history.length - MAX_HISTORY_LENGTH);
  }
}

function getConversationHistory(accountName: string, senderId: string): ConversationMessage[] {
  const key = getConversationKey(accountName, senderId);
  return conversationHistory.get(key) || [];
}

function formatHistoryForPrompt(history: ConversationMessage[]): string {
  if (history.length === 0) return "";

  return history
    .map(m => {
      const roleLabel = m.role === "user" ? "用户" : "助手";
      const prefix = m.isSummary ? "📋 " : "";
      return `${prefix}[${roleLabel}] ${m.content}`;
    })
    .join("\n\n");
}

// ── MCP Server 模式 ──────────────────────────────────────────────────────────

interface PendingMessage {
  accountName: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  contextToken?: string;
}

const pendingMessages: PendingMessage[] = [];
let mcpActiveAccount: AccountData | null = null;
let mcpPollingStarted = false;
let autoProcessEnabled = true;

/**
 * 调用 Claude CLI 自动处理消息
 */
async function autoProcessMessages(
  messages: PendingMessage[],
  accountName: string,
  account: AccountData
): Promise<void> {
  if (messages.length === 0) return;

  // 账号专属日志
  const log = (msg: string) => {
    const now = new Date();
    const time = now.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
    process.stderr.write(`[${time}] [${accountName}] ${msg}\n`);
  };

  for (const msg of messages) {
    try {
      const startTime = Date.now();
      log(`🤖 开始处理: [${msg.senderName}] ${msg.text.slice(0, 50)}...`);

      // 保存用户消息到历史
      addToConversation(accountName, msg.senderId, "user", msg.text);

      // 检查并压缩历史（如果超限）
      await checkAndCompressHistory(accountName, msg.senderId, log);

      // 获取对话历史
      const history = getConversationHistory(accountName, msg.senderId);
      const historyText = formatHistoryForPrompt(history.slice(0, -1)); // 不包含刚添加的消息

      // 构建处理提示（包含历史）
      const prompt = historyText
        ? `以下是之前的对话历史：

${historyText}

---

用户发来新消息：
发送者: ${msg.senderName}
消息内容: ${msg.text}

请根据上下文回复，要求：
1. 如果需要查询信息或执行命令，请先使用 Claude 内置工具处理
2. 最后只输出回复内容，不要输出其他内容
3. 回复要简洁，像聊天一样自然
4. 不要使用 markdown 格式
5. 直接输出回复文本，不要加引号或代码块`
        : `你收到了一条微信消息，请处理并给出回复内容。

发送者: ${msg.senderName}
消息内容: ${msg.text}

要求:
1. 如果需要查询信息或执行命令，请先使用 Claude 内置工具处理
2. 最后只输出回复内容，不要输出其他内容
3. 回复要简洁，像聊天一样自然
4. 不要使用 markdown 格式
5. 直接输出回复文本，不要加引号或代码块`;

      // 调用 Claude CLI
      const result = Bun.spawnSync({
        cmd: ["claude", "-p", prompt, "--dangerously-skip-permissions"],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 3600000, // 1 小时超时
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (result.exitCode === 0) {
        const output = result.stdout.toString().trim();
        log(`✅ Claude 响应 (${elapsed}s): ${output.slice(0, 100)}...`);

        // 保存助手回复到历史
        if (output) {
          addToConversation(accountName, msg.senderId, "assistant", output);
        }

        // 发送回复
        if (output) {
          const contextToken = msg.contextToken || getCachedContextToken(`${accountName}:${msg.senderId}`);
          if (contextToken) {
            try {
              await sendTextMessage(
                account.baseUrl,
                account.token,
                msg.senderId,
                output,
                contextToken
              );
              log(`📤 已发送回复给 [${msg.senderName}]`);
            } catch (sendErr) {
              log(`❌ 发送失败: ${String(sendErr)}`);
            }
          } else {
            log(`⚠️ 没有 context_token，无法回复`);
          }
        }
      } else {
        const error = result.stderr.toString().trim();
        log(`❌ Claude 处理失败 (${elapsed}s): ${error.slice(0, 200)}`);
      }
    } catch (err) {
      log(`❌ 自动处理异常: ${String(err)}`);
    }
  }

  // 移除已处理的消息
  for (const msg of messages) {
    const idx = pendingMessages.findIndex(
      m => m.accountName === msg.accountName && m.senderId === msg.senderId && m.text === msg.text && m.timestamp === msg.timestamp
    );
    if (idx !== -1) {
      pendingMessages.splice(idx, 1);
    }
  }
  log(`🗑️ 已从队列移除 ${messages.length} 条已处理消息，剩余 ${pendingMessages.length} 条`);
}

/**
 * 后台轮询微信消息（支持多账号）
 */
const activeAccounts = new Map<string, AccountData>();

async function startPollingForAccount(accountName: string, account: AccountData): Promise<void> {
  if (activeAccounts.has(accountName)) return;
  activeAccounts.set(accountName, account);

  const { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;

  // 账号专属日志
  const log = (msg: string) => {
    const now = new Date();
    const time = now.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
    process.stderr.write(`[${time}] [${accountName}] ${msg}\n`);
  };

  // 尝试恢复同步状态（每个账号独立的同步文件）
  const syncBufFile = path.join(CREDENTIALS_DIR, `sync_buf_${accountName}.txt`);
  try {
    if (fs.existsSync(syncBufFile)) {
      getUpdatesBuf = fs.readFileSync(syncBufFile, "utf-8");
      log(`恢复同步状态 (${getUpdatesBuf.length} bytes)`);
    }
  } catch {
    // ignore
  }

  log("开始轮询消息...");

  // 后台轮询
  (async () => {
    while (true) {
      try {
        const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isError) {
          consecutiveFailures++;

          // 友好的错误提示
          let errorMsg = `getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode}`;
          if (resp.errcode === -14) {
            errorMsg = `Token 无效或已过期，请运行 'bun setup.ts --add ${accountName}' 重新登录`;
          } else if (resp.errcode === -1) {
            errorMsg = `网络错误，正在重试...`;
          }

          log(`❌ ${errorMsg}`);

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            log(`连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，等待 ${BACKOFF_DELAY_MS / 1000}s 后重试`);
            await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
            consecutiveFailures = 0;
          } else {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }
          continue;
        }

        consecutiveFailures = 0;

        // 保存同步状态
        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          try {
            fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8");
          } catch {
            // ignore
          }
        }

        // 处理新消息
        const newMessages: PendingMessage[] = [];
        for (const msg of resp.msgs ?? []) {
          if (msg.message_type !== MSG_TYPE_USER) continue;

          const text = extractTextFromMessage(msg);
          if (!text) continue;

          const senderId = msg.from_user_id ?? "unknown";
          const senderName = senderId.split("@")[0] || senderId;

          // 缓存 context token（按账号+用户ID）
          if (msg.context_token) {
            cacheContextToken(`${accountName}:${senderId}`, msg.context_token);
          }

          const pendingMsg: PendingMessage = {
            accountName,
            senderId,
            senderName,
            text,
            timestamp: Date.now(),
            contextToken: msg.context_token,
          };

          pendingMessages.push(pendingMsg);
          newMessages.push(pendingMsg);

          log(`📩 [${senderName}] ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

          // 限制队列长度
          if (pendingMessages.length > 100) {
            pendingMessages.splice(0, pendingMessages.length - 100);
          }
        }

        // 自动处理
        if (newMessages.length > 0) {
          log(`收到 ${newMessages.length} 条新消息，队列中共 ${pendingMessages.length} 条`);

          if (autoProcessEnabled) {
            autoProcessMessages(newMessages, accountName, account).catch((err) =>
              log(`自动处理异常: ${String(err)}`)
            );
          }
        }
      } catch (err) {
        consecutiveFailures++;
        log(`轮询异常: ${String(err)}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
          consecutiveFailures = 0;
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
  })().catch((err) => log(`轮询线程异常退出: ${String(err)}`));
}

/**
 * 创建 MCP Server
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
      instructions: [
        "WeChat Bridge MCP Server - 通过工具与微信用户交互",
        "",
        "使用方式:",
        "1. 调用 wechat_poll 获取待处理的微信消息",
        "2. 处理消息后调用 wechat_send 发送回复",
        "",
        "注意：wechat_poll 返回空数组表示没有新消息，请稍后重试。",
      ].join("\n"),
    }
  );

  // 注册工具列表
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "wechat_poll",
        description: "获取待处理的微信消息。返回消息列表，每个消息包含 sender_id、sender_name、text。",
        inputSchema: {
          type: "object" as const,
          properties: {
            max_count: {
              type: "integer",
              description: "最多返回多少条消息（默认 10）",
            },
          },
        },
      },
      {
        name: "wechat_send",
        description: "发送微信消息给指定用户。支持多账号：sender_id 格式为 \"账号名:用户ID\" 时会自动路由到对应账号",
        inputSchema: {
          type: "object" as const,
          properties: {
            sender_id: {
              type: "string",
              description: "接收者的 ID（从 wechat_poll 获取，格式可能是 \"账号名:用户ID\"）",
            },
            text: {
              type: "string",
              description: "要发送的消息内容（纯文本，不支持 markdown）",
            },
            account_name: {
              type: "string",
              description: "可选，指定使用的账号名称。不指定时自动根据 sender_id 判断",
            },
          },
          required: ["sender_id", "text"],
        },
      },
      {
        name: "wechat_status",
        description: "获取微信连接状态和统计信息",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "wechat_auto_process",
        description: "启用/禁用新消息自动处理。启用后，有新微信消息时会自动调用 Claude CLI 处理并回复。",
        inputSchema: {
          type: "object" as const,
          properties: {
            enabled: {
              type: "boolean",
              description: "true 启用自动处理，false 禁用",
            },
          },
          required: ["enabled"],
        },
      },
    ],
  }));

  // 处理工具调用
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    switch (name) {
      case "wechat_poll": {
        const maxCount = (args?.max_count as number) || 10;
        const messages = pendingMessages.splice(0, maxCount);

        if (messages.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ messages: [], has_more: false }),
            }],
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              messages: messages.map(m => ({
                account_name: m.accountName,
                sender_id: m.accountName === "default" ? m.senderId : `${m.accountName}:${m.senderId}`,
                sender_name: m.senderName,
                text: m.text,
                timestamp: m.timestamp,
              })),
              has_more: pendingMessages.length > 0,
            }),
          }],
        };
      }

      case "wechat_send": {
        const { sender_id, text, account_name } = args as { sender_id: string; text: string; account_name?: string };

        // 确定使用哪个账号
        let targetAccount: { name: string; data: AccountData } | null = null;

        if (account_name && activeAccounts.has(account_name)) {
          targetAccount = { name: account_name, data: activeAccounts.get(account_name)! };
        } else if (sender_id.includes(":")) {
          // sender_id 可能是 "accountName:userId" 格式
          const [accName, ...rest] = sender_id.split(":");
          const realSenderId = rest.join(":");
          if (activeAccounts.has(accName)) {
            targetAccount = { name: accName, data: activeAccounts.get(accName)! };
            // 使用原始的 sender_id 查找 context token
            const contextToken = getCachedContextToken(sender_id) || getCachedContextToken(`${accName}:${realSenderId}`);
            if (contextToken) {
              try {
                await sendTextMessage(
                  targetAccount.data.baseUrl,
                  targetAccount.data.token,
                  realSenderId,
                  text,
                  contextToken
                );
                return {
                  content: [{
                    type: "text" as const,
                    text: JSON.stringify({ success: true, account: accName }),
                  }],
                };
              } catch (err) {
                return {
                  content: [{
                    type: "text" as const,
                    text: JSON.stringify({ success: false, error: String(err) }),
                  }],
                };
              }
            }
          }
        }

        // 默认使用第一个账号
        if (!targetAccount && activeAccounts.size > 0) {
          const [firstName, firstData] = [...activeAccounts.entries()][0];
          targetAccount = { name: firstName, data: firstData };
        }

        if (!targetAccount) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "没有可用的微信账号" }),
            }],
          };
        }

        const contextToken = getCachedContextToken(`${targetAccount.name}:${sender_id}`) || getCachedContextToken(sender_id);
        if (!contextToken) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: `没有 ${sender_id} 的 context_token，用户需要先发送一条消息`,
              }),
            }],
          };
        }

        try {
          await sendTextMessage(
            targetAccount.data.baseUrl,
            targetAccount.data.token,
            sender_id,
            text,
            contextToken
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: true }),
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, error: String(err) }),
            }],
          };
        }
      }

      case "wechat_status": {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              accounts: [...activeAccounts.entries()].map(([name, data]) => ({
                name,
                account_id: data.accountId,
              })),
              pending_messages: pendingMessages.length,
              auto_process_enabled: autoProcessEnabled,
            }),
          }],
        };
      }

      case "wechat_auto_process": {
        const { enabled } = args as { enabled: boolean };
        autoProcessEnabled = enabled;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              auto_process_enabled: autoProcessEnabled,
              message: enabled ? "已启用新消息自动处理" : "已禁用新消息自动处理",
            }),
          }],
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  });

  return server;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║     WeChat MCP Server v" + MCP_SERVER_VERSION + "         ║");
  console.log("║     Claude Code 工具调用模式           ║");
  console.log("╚════════════════════════════════════════╝\n");

  // 1. 加载所有已配置的账号
  const accounts = loadAllAccounts();

  if (accounts.length === 0) {
    mcpLog("❌ 未找到微信凭据");
    mcpLog("请先运行 'bun setup.ts' 扫码登录");
    process.exit(1);
  }

  // 显示已加载的账号
  mcpLog(`已加载 ${accounts.length} 个微信账号: ${accounts.map(a => a.name).join(", ")}`);

  // 2. 创建 MCP Server
  const server = createMcpServer();

  // 3. 为每个账号启动轮询
  for (const { name, data } of accounts) {
    await startPollingForAccount(name, data);
  }
  mcpLog("所有账号的消息轮询已启动");

  // 4. 连接 MCP Server
  await server.connect(new StdioServerTransport());
  mcpLog("MCP Server 已连接，等待 Claude Code 调用...");
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
