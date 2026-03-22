#!/usr/bin/env bun
/**
 * WeChat Channel Setup — 多账号扫码登录工具
 *
 * 使用方式:
 *   bun setup.ts                      # 交互式管理账号
 *   bun setup.ts --add                # 直接添加新账号
 *   bun setup.ts --add work           # 添加名为 work 的账号
 *   bun setup.ts --list               # 列出所有已配置账号
 *   bun setup.ts --delete work        # 删除名为 work 的账号
 *
 * 凭据保存至: ~/.claude/channels/wechat/accounts/{name}.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CREDENTIALS_DIR = path.join(process.env.HOME || "~", ".claude", "channels", "wechat");
const ACCOUNTS_DIR = path.join(CREDENTIALS_DIR, "accounts");

// ── 账号管理 ────────────────────────────────────────────────────────────────

interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

interface SavedAccount {
  name: string;
  data: AccountData;
  file: string;
}

function ensureAccountsDir(): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function loadAllAccounts(): SavedAccount[] {
  const accounts: SavedAccount[] = [];

  // 检查新路径
  if (fs.existsSync(ACCOUNTS_DIR)) {
    for (const file of fs.readdirSync(ACCOUNTS_DIR)) {
      if (file.endsWith(".json")) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), "utf-8"));
          accounts.push({
            name: file.replace(".json", ""),
            data,
            file: path.join(ACCOUNTS_DIR, file),
          });
        } catch {
          // ignore
        }
      }
    }
  }

  // 兼容旧的单账号路径
  const legacyFile = path.join(CREDENTIALS_DIR, "account.json");
  if (fs.existsSync(legacyFile) && accounts.length === 0) {
    try {
      const data = JSON.parse(fs.readFileSync(legacyFile, "utf-8"));
      accounts.push({
        name: "default",
        data,
        file: legacyFile,
      });
    } catch {
      // ignore
    }
  }

  return accounts;
}

function saveAccount(name: string, data: AccountData): string {
  ensureAccountsDir();
  const file = path.join(ACCOUNTS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
  return file;
}

function deleteAccount(name: string): boolean {
  const file = path.join(ACCOUNTS_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

/**
 * 检查账号是否重复（按 accountId）
 * 返回: 重复的账号名称，如果不重复则返回 null
 */
function findDuplicateAccount(accountId: string, excludeName?: string): string | null {
  const accounts = loadAllAccounts();
  for (const acc of accounts) {
    if (acc.name === excludeName) continue;
    if (acc.data.accountId === accountId) {
      return acc.name;
    }
  }
  return null;
}

// ── 二维码登录 ──────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`获取二维码失败: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`状态查询失败: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function doQRLogin(): Promise<AccountData | null> {
  const totalDeadline = Date.now() + 600_000; // 10 分钟总超时

  while (Date.now() < totalDeadline) {
    console.log("正在获取微信登录二维码...\n");
    const qrResp = await fetchQRCode(DEFAULT_BASE_URL);

    // 显示二维码
    try {
      const qrterm = await import("qrcode-terminal");
      await new Promise<void>((resolve) => {
        qrterm.default.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
          console.log(qr);
          resolve();
        });
      });
    } catch {
      console.log(`请在浏览器打开此链接扫码: ${qrResp.qrcode_img_content}\n`);
    }

    console.log("请用微信扫描上方二维码（约 8 分钟有效，过期自动刷新）...\n");

    const qrDeadline = Date.now() + 480_000;
    let scannedPrinted = false;
    let needRefresh = false;

    while (Date.now() < qrDeadline && Date.now() < totalDeadline) {
      const status = await pollQRStatus(DEFAULT_BASE_URL, qrResp.qrcode);

      switch (status.status) {
        case "wait":
          process.stdout.write(".");
          break;
        case "scaned":
          if (!scannedPrinted) {
            console.log("\n👀 已扫码，请在微信中确认...");
            scannedPrinted = true;
          }
          break;
        case "expired":
          console.log("\n二维码已过期，正在刷新...");
          needRefresh = true;
          break;
        case "confirmed": {
          if (!status.ilink_bot_id || !status.bot_token) {
            console.error("\n登录失败：服务器未返回完整信息。");
            return null;
          }
          return {
            token: status.bot_token,
            baseUrl: status.baseurl || DEFAULT_BASE_URL,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          };
        }
      }

      if (needRefresh) {
        console.log();
        break;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!needRefresh && Date.now() >= qrDeadline) {
      console.log("\n等待超时，正在刷新二维码...");
    }
  }

  console.log("\n登录超时。");
  return null;
}

// ── 交互式界面 ──────────────────────────────────────────────────────────────

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function printAccountList(accounts: SavedAccount[]): void {
  if (accounts.length === 0) {
    console.log("  暂无已配置的账号\n");
    return;
  }
  console.log("  已配置的账号:");
  for (const acc of accounts) {
    const time = new Date(acc.data.savedAt).toLocaleString("zh-CN");
    console.log(`  - ${acc.name}`);
    console.log(`      账号 ID: ${acc.data.accountId}`);
    console.log(`      保存时间: ${time}`);
  }
  console.log();
}

async function addNewAccount(defaultName?: string): Promise<void> {
  const rl = createRL();

  // 输入账号名称
  let name = defaultName || "";
  if (!name) {
    name = await question(rl, "请输入账号名称（如 work, personal）: ");
    name = name.trim() || `account_${Date.now()}`;
  }

  // 检查名称是否已存在
  const accounts = loadAllAccounts();
  const existingNames = new Set(accounts.map(a => a.name));

  if (existingNames.has(name)) {
    console.log(`\n⚠️  账号 "${name}" 已存在，登录后将更新该账号。`);
  }

  rl.close();

  // 执行登录
  console.log(`\n正在为账号 "${name}" 登录...\n`);
  const account = await doQRLogin();

  if (!account) {
    console.log("登录失败。");
    process.exit(1);
  }

  // 检查账号 ID 是否重复
  const duplicateName = findDuplicateAccount(account.accountId, name);
  if (duplicateName) {
    console.log(`\n⚠️  检测到该微信账号已配置为 "${duplicateName}"`);
    console.log("    保存后将存在重复配置，建议删除旧配置。");
  }

  // 保存账号
  const file = saveAccount(name, account);
  console.log(`\n✅ 账号 "${name}" 配置成功！`);
  console.log(`   账号 ID: ${account.accountId}`);
  console.log(`   凭据保存: ${file}`);
}

async function deleteAccountInteractive(name?: string): Promise<void> {
  const accounts = loadAllAccounts();

  if (accounts.length === 0) {
    console.log("没有可删除的账号。");
    return;
  }

  const rl = createRL();

  if (!name) {
    console.log("\n已配置的账号:");
    for (const acc of accounts) {
      console.log(`  - ${acc.name} (${acc.data.accountId})`);
    }
    console.log();
    name = await question(rl, "请输入要删除的账号名称: ");
  }

  rl.close();

  name = name.trim();
  if (!name) {
    console.log("未输入账号名称。");
    return;
  }

  if (deleteAccount(name)) {
    console.log(`✅ 账号 "${name}" 已删除。`);
  } else {
    console.log(`❌ 账号 "${name}" 不存在。`);
  }
}

async function interactiveMode(): Promise<void> {
  const accounts = loadAllAccounts();

  console.log("\n╔════════════════════════════════════════╗");
  console.log("║       微信多账号管理工具               ║");
  console.log("╚════════════════════════════════════════╝\n");

  printAccountList(accounts);

  const rl = createRL();

  console.log("操作选项:");
  console.log("  1. 添加新账号");
  console.log("  2. 更新现有账号");
  console.log("  3. 删除账号");
  console.log("  4. 退出");

  const choice = await question(rl, "\n请选择 [1-4]: ");
  rl.close();

  switch (choice.trim()) {
    case "1":
      await addNewAccount();
      break;
    case "2": {
      if (accounts.length === 0) {
        console.log("没有可更新的账号，请先添加。");
        await addNewAccount();
      } else {
        const rl2 = createRL();
        console.log("\n已配置的账号:");
        for (const acc of accounts) {
          console.log(`  - ${acc.name}`);
        }
        const name = await question(rl2, "\n请输入要更新的账号名称: ");
        rl2.close();
        await addNewAccount(name.trim() || undefined);
      }
      break;
    }
    case "3":
      await deleteAccountInteractive();
      break;
    case "4":
      console.log("退出。");
      break;
    default:
      console.log("无效选择。");
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "--add":
    case "-a":
      await addNewAccount(args[1]);
      break;

    case "--list":
    case "-l":
      console.log("\n已配置的微信账号:\n");
      printAccountList(loadAllAccounts());
      break;

    case "--delete":
    case "-d":
      await deleteAccountInteractive(args[1]);
      break;

    case "--help":
    case "-h":
      console.log(`
微信多账号管理工具

用法:
  bun setup.ts                  交互式管理
  bun setup.ts --add [name]     添加新账号
  bun setup.ts --list           列出所有账号
  bun setup.ts --delete [name]  删除账号
`);
      break;

    default:
      await interactiveMode();
  }
}

main().catch((err) => {
  console.error(`错误: ${err}`);
  process.exit(1);
});
