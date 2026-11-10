import { createHash, constants, publicEncrypt, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

// 与 codex-app-server 使用同一个 New API 账号服务；密码和模型密钥只经过主进程。
const server = (process.env.NEWAPI_URL || "https://dashboard.shuyusen.club").replace(/\/+$/, "");
const accountFile = () => path.join(app.getPath("userData"), "account.json");
interface Account {
  server: string;
  userId: number;
  username: string;
  displayName: string;
  apiKey: string;
  refresh: string | null;
  models: string[];
}
interface Token {
  id: number;
  user_id: number;
  name: string;
  status: number;
  expired_time: number;
  unlimited_quota: boolean;
  remain_quota: number;
}
interface LoginData {
  access_token?: string;
  user?: { id: number; username: string; display_name?: string };
  require_2fa?: boolean;
  flow_token?: string;
}
let current: Account | null = null;
let busy = false;
let challenge: { token: string; expires: number } | null = null;

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function save(account: Account): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭证加密不可用，无法保存登录信息");
  const encrypt = (text: string) => safeStorage.encryptString(text).toString("base64");
  writeJson(accountFile(), { ...account, apiKey: encrypt(account.apiKey), refresh: account.refresh ? encrypt(account.refresh) : null });
  current = account;
}

export function loadAccount(): Account | null {
  current = null;
  try {
    const raw = JSON.parse(readFileSync(accountFile(), "utf8")) as Account;
    if (raw.server !== server || !Number.isInteger(raw.userId) || raw.userId <= 0 || !Array.isArray(raw.models) || !raw.models.length) return null;
    current = { ...raw, apiKey: safeStorage.decryptString(Buffer.from(raw.apiKey, "base64")), refresh: raw.refresh ? safeStorage.decryptString(Buffer.from(raw.refresh, "base64")) : null };
    return current;
  } catch {
    return null;
  }
}

export function accountInfo() {
  return current ? { userId: current.userId, username: current.username, displayName: current.displayName } : null;
}

async function call<T>(method: string, route: string, options: { body?: unknown; access?: string; userId?: number; refresh?: string } = {}) {
  let response: Response;
  try {
    response = await fetch(`${server}${route}`, {
      method,
      headers: {
        "accept-language": "zh-CN",
        ...(options.body !== undefined && { "content-type": "application/json" }),
        ...(options.access && { authorization: `Bearer ${options.access}` }),
        ...(options.userId && { "New-Api-User": String(options.userId) }),
        ...(options.refresh && { cookie: `new_api_refresh=${options.refresh}`, origin: server }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("暂时无法连接登录服务器，请检查网络后重试");
  }
  const json = await response.json().catch(() => null) as { success?: boolean; message?: string; data: T } | null;
  if (!response.ok || json?.success !== true) {
    throw Object.assign(new Error(json?.message || `服务器返回 ${response.status}`), {
      rejected: json?.success === false || [400, 401, 403, 404, 422, 429].includes(response.status),
    });
  }
  return { data: json.data, response };
}

async function allTokens(access: string, userId: number): Promise<Token[]> {
  const tokens: Token[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const { data } = await call<Token[] | { items: Token[]; total: number; page?: number }>("GET", `/api/token/?p=${page}&page_size=100&size=100`, { access, userId });
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items)) throw new Error("服务器令牌列表格式不正确");
    if (!Array.isArray(data)) {
      if (!Number.isInteger(data.total) || data.total < 0 || (total !== undefined && data.total !== total) || (data.page !== undefined && data.page !== page)) throw new Error("令牌列表发生变化，请重试");
      total = data.total;
    }
    for (const token of items) {
      if (!Number.isInteger(token.id) || token.id <= 0 || token.user_id !== userId || ids.has(token.id)) throw new Error("服务器返回的令牌归属或分页不正确");
      ids.add(token.id);
      tokens.push(token);
    }
    if (total !== undefined) {
      if (tokens.length === total) return tokens;
      if (tokens.length > total || !items.length) throw new Error("未能完整读取账号令牌，请重试");
    } else if (!items.length) return tokens;
  }
  throw new Error("账号令牌过多，请在账号后台管理后重试");
}

async function modelKey(access: string, userId: number) {
  const journal = path.join(app.getPath("userData"), `key-provision-${createHash("sha256").update(server).digest("hex").slice(0, 16)}-${userId}.json`);
  let tokens = await allTokens(access, userId);
  if (!tokens.length) {
    // 请求超时后保留创建记录，下一次只查询，避免每次登录重复生成密钥。
    let pending: { name: string; attempted: boolean } | null = null;
    try { pending = JSON.parse(readFileSync(journal, "utf8")); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("密钥创建记录无法读取"); }
    if (pending?.attempted) throw new Error("上次创建密钥的结果尚未确认，请稍后重试或在账号后台核实");
    const name = `Claude桌面版-${randomBytes(4).toString("hex")}`;
    writeJson(journal, { name, attempted: true });
    try {
      await call("POST", "/api/token/", { access, userId, body: { name, remain_quota: 0, expired_time: -1, unlimited_quota: true, model_limits_enabled: false, model_limits: "", group: "" } });
    } catch (err) {
      if ((err as { rejected?: boolean }).rejected) rmSync(journal, { force: true });
      throw err;
    }
    tokens = await allTokens(access, userId);
    if (!tokens.some((token) => token.name === name)) throw new Error("密钥创建结果尚未确认，请稍后重试");
  }
  const usable = tokens.filter((t) => t.status === 1 && (t.expired_time === -1 || t.expired_time > Date.now() / 1000) && (t.unlimited_quota || t.remain_quota > 0));
  for (const token of usable.sort((a, b) => b.id - a.id)) {
    const { data } = await call<{ key: string }>("POST", `/api/token/${token.id}/key`, { access, userId });
    const raw = String(data?.key ?? "").replace(/^sk-/, "").trim();
    if (!/^[\w-]+$/.test(raw)) throw new Error("服务器没有返回有效的模型密钥");
    const apiKey = `sk-${raw}`;
    const response = await fetch(`${server}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
    if ([401, 403].includes(response.status)) continue;
    if (!response.ok) throw new Error("暂时无法读取账号模型列表，请稍后重试");
    const body = await response.json() as { data?: { id: string; owned_by?: string; supported_endpoint_types?: string[] }[] };
    if (!Array.isArray(body.data)) throw new Error("服务器模型列表格式不正确");
    const nonChat = /image|video|tts|speech|audio|voice|lipsync|avatar|upscal|3d|embed|bge|rerank|whisper|transcri|dall-e|edit|cleanup|visuals|background|style-transfer|blend|sequential|decomposition|web-search|moderation|realtime|tripo|easydoc|-fetch-|auto-review|^auto$/i;
    const models = body.data.filter((m) => typeof m.id === "string" && !m.id.includes("/") && !nonChat.test(m.id) && m.owned_by !== "task plugin" && !m.supported_endpoint_types?.includes("image-generation")).map((m) => m.id);
    if (models.length) return { apiKey, models };
  }
  throw new Error("账号没有可用的对话模型，请检查密钥权限、有效期和额度");
}

export async function loginAccount(username: unknown, password: unknown, code?: unknown) {
  if (busy) throw new Error("正在登录，请稍候");
  busy = true;
  try {
    let result: Awaited<ReturnType<typeof call<LoginData>>>;
    if (typeof code === "string" && code.trim()) {
      if (!challenge || challenge.expires < Date.now()) throw new Error("验证已过期，请重新输入账号密码登录");
      result = await call<LoginData>("POST", "/api/user/login/2fa", { body: { flow_token: challenge.token, code: code.trim() } });
    } else {
      challenge = null;
      if (typeof username !== "string" || !username.trim() || username.length > 254 || typeof password !== "string" || !password || password.length > 4096) throw new Error("请输入有效的用户名和密码");
      const { data: encryption } = await call<{ enabled: boolean; public_key?: string; kid?: string }>("GET", "/api/user/login/encryption-key");
      const body: Record<string, string> = { username: username.trim() };
      if (encryption?.enabled) {
        if (!encryption.public_key || !encryption.kid) throw new Error("服务器登录加密配置不完整");
        body.password_encrypted = publicEncrypt({ key: encryption.public_key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString("base64");
        body.encryption_key_id = encryption.kid;
      } else body.password = password;
      result = await call<LoginData>("POST", "/api/user/login", { body });
    }
    const { data, response } = result;
    if (data.require_2fa && data.flow_token) {
      challenge = { token: data.flow_token, expires: Date.now() + 5 * 60_000 };
      return { need2fa: true };
    }
    if (!data.access_token || !data.user || !Number.isInteger(data.user.id) || data.user.id <= 0) throw new Error("服务器未返回完整的登录信息");
    const refresh = response.headers.getSetCookie().map((c) => /^new_api_refresh=([^;]*)/.exec(c)?.[1]).find(Boolean) ?? null;
    try {
      const keys = await modelKey(data.access_token, data.user.id);
      save({ server, userId: data.user.id, username: data.user.username, displayName: data.user.display_name || data.user.username, refresh, ...keys });
    } catch (err) {
      if (refresh) await call("POST", "/api/user/auth/logout", { refresh }).catch(() => {});
      throw err;
    }
    challenge = null;
    return { need2fa: false };
  } finally { busy = false; }
}

export async function logoutAccount(): Promise<void> {
  const refresh = current?.refresh;
  rmSync(accountFile(), { force: true });
  current = null;
  challenge = null;
  if (refresh) await call("POST", "/api/user/auth/logout", { refresh }).catch(() => {});
}

export function accountEnv(): Record<string, string> {
  if (!current) throw new Error("请先登录");
  const model = process.env.DESKTOP_DEFAULT_MODEL || current.models.find((m) => /claude.*sonnet/i.test(m)) || current.models.find((m) => /claude/i.test(m)) || current.models[0]!;
  const dataDir = path.join(app.getPath("userData"), "accounts", `${createHash("sha256").update(server).digest("hex").slice(0, 12)}-${current.userId}`);
  return {
    DESKTOP_ACCOUNT_AUTH: "true", ANTHROPIC_BASE_URL: server, ANTHROPIC_AUTH_TOKEN: current.apiKey,
    ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: model, NEWAI_API_KEY: current.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CONFIG_DIR: path.join(dataDir, "claude-home"), WORKSPACE_DIR: path.join(dataDir, "workspace"),
    AGENT_DESKTOP_HOME: path.join(dataDir, "agent-desktop"),
  };
}
