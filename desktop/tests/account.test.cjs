const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { stripTypeScriptTypes } = require("node:module");

// Run the real account module with isolated disk storage and a fake New API server.
const compiled = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "../src/account.ts"), "utf8"))
  .replace(/^import \{([^}]+)\} from "([^"]+)";/gm, 'const {$1} = require("$2");')
  .replace(/^import path from "node:path";/m, 'const path = require("node:path");')
  .replace(/^export /gm, "")
  + "\nObject.assign(exports, {loadAccount, accountInfo, loginAccount, logoutAccount, accountEnv});";

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-account-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const key = crypto.randomBytes(32);
  let tokens = options.noTokens ? [] : [{ id: 3, user_id: 42, name: "existing", status: 1, expired_time: -1, unlimited_quota: true }];
  const safeStorage = {
    isEncryptionAvailable: () => options.encryptionAvailable !== false,
    encryptString: (value) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (value) => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ route, ...init, body });
    if (options.respond) {
      const response = await options.respond(route, init, body);
      if (response) return response;
    }
    let data;
    if (route === "/api/user/login/encryption-key") data = options.encryption || { enabled: false };
    else if (route === "/api/user/login" || route === "/api/user/login/2fa") {
      if (route === "/api/user/login" && options.twoFactor) data = { require_2fa: true, flow_token: "flow-secret" };
      else data = { access_token: "access-secret", user: { id: 42, username: "alice", display_name: "Alice" } };
    } else if (route === "/api/token/" && init.method === "GET") data = { items: tokens, total: tokens.length, page: 1 };
    else if (route === "/api/token/" && init.method === "POST") {
      if (options.createTimeout) throw new Error("timeout");
      tokens = [{ id: 5, user_id: 42, name: body.name, status: 1, expired_time: -1, unlimited_quota: true }];
      data = {};
    } else if (/\/api\/token\/\d+\/key/.test(route)) data = { key: "model-secret" };
    else if (route === "/v1/models") return Response.json({ data: [{ id: "claude-sonnet-4-6" }, { id: "image-model" }] });
    else if (route === "/api/user/auth/logout") data = {};
    else throw new Error(`Unexpected route ${route}`);
    return Response.json({ success: true, data }, { headers: route.includes("/login") ? { "set-cookie": "new_api_refresh=refresh-secret; HttpOnly; Secure" } : {} });
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, URL, AbortSignal, fetch,
    process: { env: {}, platform: process.platform },
    require: (name) => name === "electron" ? { app: { getPath: () => dir }, safeStorage } : require(name),
  });
  return { api: exports, dir, requests };
}

test("login reuses a token, encrypts secrets, restores login, and injects only account credentials", async (t) => {
  const { api, dir, requests } = fixture(t);
  await api.loginAccount("alice", "password-secret");
  assert.equal(api.accountInfo().username, "alice");
  assert.equal(api.accountInfo().apiKey, undefined);
  const saved = fs.readFileSync(path.join(dir, "account.json"), "utf8");
  for (const secret of ["password-secret", "model-secret", "refresh-secret", "access-secret"]) assert.ok(!saved.includes(secret));
  assert.equal(api.loadAccount().apiKey, "sk-model-secret");
  const env = api.accountEnv();
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-model-secret");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
  assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(path.join(dir, "accounts")));
  assert.equal(requests.filter((r) => r.route === "/api/token/" && r.method === "POST").length, 0);
});

test("a rejected password never saves an account or provisions a model key", async (t) => {
  const { api, dir, requests } = fixture(t, { respond: (route) => route === "/api/user/login" ? Response.json({ success: false, message: "Bad password" }) : null });
  await assert.rejects(api.loginAccount("alice", "bad"), /Bad password/);
  assert.equal(fs.existsSync(path.join(dir, "account.json")), false);
  assert.equal(requests.some((r) => r.route.startsWith("/api/token")), false);
});

test("login requires and completes the server's second factor", async (t) => {
  const { api, requests } = fixture(t, { twoFactor: true });
  assert.equal((await api.loginAccount("alice", "password")).need2fa, true);
  assert.equal(api.accountInfo(), null);
  await api.loginAccount("alice", "", "123456");
  assert.equal(api.accountInfo().userId, 42);
  assert.equal(requests.find((r) => r.route === "/api/user/login/2fa").body.flow_token, "flow-secret");
});

test("password encryption sends the server key id and no plain password", async (t) => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { api, requests } = fixture(t, { encryption: { enabled: true, public_key: publicKey.export({ type: "spki", format: "pem" }), kid: "key-1" } });
  await api.loginAccount("alice", "password-secret");
  const body = requests.find((r) => r.route === "/api/user/login").body;
  assert.equal(body.password, undefined);
  assert.equal(body.encryption_key_id, "key-1");
  assert.equal(Buffer.from(body.password_encrypted, "base64").length, 256);
});

test("a timed out key creation is not repeated on the next login", async (t) => {
  const { api, requests } = fixture(t, { noTokens: true, createTimeout: true });
  await assert.rejects(api.loginAccount("alice", "password"));
  await assert.rejects(api.loginAccount("alice", "password"));
  assert.equal(requests.filter((r) => r.route === "/api/token/" && r.method === "POST").length, 1);
});

test("key provisioning creates one token and logout clears disk and memory even offline", async (t) => {
  const { api, dir, requests } = fixture(t, { noTokens: true, respond: (route) => { if (route === "/api/user/auth/logout") throw new Error("offline"); } });
  await api.loginAccount("alice", "password");
  assert.equal(requests.filter((r) => r.route === "/api/token/" && r.method === "POST").length, 1);
  await api.logoutAccount();
  assert.equal(api.accountInfo(), null);
  assert.equal(api.loadAccount(), null);
  assert.equal(fs.existsSync(path.join(dir, "account.json")), false);
  assert.throws(() => api.accountEnv());
});

test("unavailable system encryption prevents saving credentials", async (t) => {
  const { api, dir } = fixture(t, { encryptionAvailable: false });
  await assert.rejects(api.loginAccount("alice", "password"));
  assert.equal(fs.existsSync(path.join(dir, "account.json")), false);
});
