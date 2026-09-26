import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

// Runs real Next.js pages, middleware, cookies, and Server Actions against a
// deterministic HTTP Supabase substitute. Never uses a real account or database.
const users = new Map();
const sessions = new Map();
const logoutScopes = [];
let profileFailure = false;
let logoutFailure = false;
let app;
let origin;
let appOutput = "";

for (const [index, name, role, active] of [
  [1, "admin", "admin", true],
  [2, "cashier", "cashier", true],
  [3, "missing", null, true],
  [4, "inactive", "cashier", false],
  [5, "invalid", "manager", true],
]) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  users.set(`${name}@example.test`, {
    user: { id, email: `${name}@example.test`, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    profile: role ? { id, full_name: `Test ${name}`, role, active, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null,
  });
}

function newSession(record) {
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ sub: record.user.id, exp: expires, aud: "authenticated", role: "authenticated" })}.test-signature`;
  sessions.set(token, record);
  return { access_token: token, refresh_token: `refresh-${record.user.id}`, token_type: "bearer", expires_in: 3600, expires_at: expires, user: record.user };
}

const supabase = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  const record = sessions.get(token);
  if (url.pathname === "/auth/v1/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const credentials = JSON.parse(body);
    const account = users.get(credentials.email);
    if (!account || credentials.password !== "test-password") return send(400, { code: "invalid_credentials", msg: "Invalid credentials" });
    return send(200, newSession(account));
  }
  if (url.pathname === "/auth/v1/user") {
    return record ? send(200, record.user) : send(401, { msg: "Invalid token" });
  }
  if (url.pathname === "/auth/v1/logout") {
    logoutScopes.push(url.searchParams.get("scope"));
    if (logoutFailure) return send(503, { msg: "Unavailable" });
    sessions.delete(token);
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/rest/v1/pos_profiles") {
    if (profileFailure) return send(503, { message: "Unavailable" });
    if (!record || url.searchParams.get("id") !== `eq.${record.user.id}`) return send(403, { message: "Forbidden" });
    return send(200, record.profile ? [record.profile] : []);
  }
  return send(404, { message: `Unexpected path: ${url.pathname}` });
});

before(async () => {
  supabase.listen(0, "127.0.0.1");
  await once(supabase, "listening");
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const appPort = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  origin = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-not-a-secret" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  app.stdout.on("data", (data) => { appOutput += data; });
  app.stderr.on("data", (data) => { appOutput += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) throw new Error(appOutput);
    try {
      if ((await fetch(`${origin}/login`)).ok) return;
    } catch { /* Wait for the production server. */ }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${appOutput}`);
});

after(async () => {
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill();
    await exited;
  }
  await new Promise((resolve) => supabase.close(resolve));
});

function browser() {
  const jar = new Map();
  return {
    jar,
    async request(path, options = {}) {
      const response = await fetch(`${origin}${path}`, {
        ...options, redirect: "manual",
        headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...options.headers },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    },
    async submit(path, values = {}) {
      const page = await this.request(path);
      assert.equal(page.status, 200);
      const html = await page.text();
      const action = html.match(/name="(\$ACTION_ID_[^"]+)"/);
      assert.ok(action, "Server Action form must be present");
      const body = new FormData();
      body.set(action[1], "");
      for (const [key, value] of Object.entries(values)) body.set(key, value);
      return this.request(path, { method: "POST", headers: { origin }, body });
    },
    async login(name, password = "test-password") {
      return this.submit("/login", { email: `${name}@example.test`, password });
    },
  };
}

function redirectTo(response, path) {
  assert.ok([303, 307].includes(response.status), `Expected redirect, got ${response.status}`);
  assert.equal(new URL(response.headers.get("location"), origin).pathname + new URL(response.headers.get("location"), origin).search, path);
}

test("all application routes redirect unauthenticated visitors", async () => {
  const client = browser();
  for (const route of ["/", "/sales", "/reports", "/employees"]) redirectTo(await client.request(route), "/login");
  const login = await client.request("/login");
  assert.match(await login.text(), /ელფოსტა/);
});

test("active admin can log in, see Georgian role and all placeholders, then log out", async () => {
  const client = browser();
  redirectTo(await client.login("admin"), "/");
  const home = await client.request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("cache-control"), /no-store/);
  const html = await home.text();
  for (const text of ["Test admin", "ადმინისტრატორი", "სალაროს მოდული მზადდება", "გამოსვლა", "რეპორტები", "თანამშრომლები"]) assert.ok(html.includes(text));
  for (const route of ["/sales", "/reports", "/employees"]) assert.equal((await client.request(route)).status, 200);
  redirectTo(await client.request("/login"), "/");
  redirectTo(await client.submit("/"), "/login");
  assert.equal(client.jar.size, 0);
  redirectTo(await client.request("/"), "/login");
  assert.ok(logoutScopes.length > 0);
  assert.ok(logoutScopes.every((scope) => scope === "local"));
});

test("cashier role renders and direct admin routes are denied", async () => {
  const client = browser();
  redirectTo(await client.login("cashier"), "/");
  const html = await (await client.request("/")).text();
  assert.ok(html.includes("მოლარე"));
  assert.ok(!html.includes('href="/reports"'));
  assert.ok(!html.includes('href="/employees"'));
  for (const route of ["/reports", "/employees"]) {
    const response = await client.request(route);
    const content = await response.text();
    // Next.js may stream a redirect after the shell has rendered.
    assert.ok([303, 307].includes(response.status) || content.includes("NEXT_REDIRECT"));
    assert.ok(!content.includes("მოდული მზადდება"));
  }
});

for (const [name, reason, message] of [
  ["missing", "denied", "ამ მომხმარებელს POS სისტემაზე წვდომა არ აქვს."],
  ["inactive", "inactive", "მომხმარებელი გათიშულია."],
  ["invalid", "denied", "ამ მომხმარებელს POS სისტემაზე წვდომა არ აქვს."],
]) {
  test(`${name} POS profile is denied and the new session is cleared`, async () => {
    const client = browser();
    redirectTo(await client.login(name), `/login?error=${reason}`);
    assert.equal(client.jar.size, 0);
    assert.ok((await (await client.request(`/login?error=${reason}`)).text()).includes(message));
    redirectTo(await client.request("/"), "/login");
  });
}

test("invalid credentials are rejected", async () => {
  const client = browser();
  redirectTo(await client.login("admin", "wrong"), "/login?error=credentials");
  assert.equal(client.jar.size, 0);
});

test("deactivating an already logged-in user denies the next request", async () => {
  const client = browser();
  redirectTo(await client.login("cashier"), "/");
  const profile = users.get("cashier@example.test").profile;
  profile.active = false;
  try {
    redirectTo(await client.request("/sales"), "/login?error=inactive");
    assert.equal(client.jar.size, 0);
  } finally { profile.active = true; }
});

test("profile query failure fails closed", async () => {
  const client = browser();
  profileFailure = true;
  try {
    redirectTo(await client.login("admin"), "/login?error=unavailable");
    assert.equal(client.jar.size, 0);
  } finally { profileFailure = false; }
});

test("logout clears POS cookies even when remote logout fails", async () => {
  const client = browser();
  redirectTo(await client.login("admin"), "/");
  client.jar.set("orders-session", "unrelated-session");
  logoutFailure = true;
  try {
    redirectTo(await client.submit("/"), "/login");
    assert.deepEqual([...client.jar.keys()], ["orders-session"]);
    redirectTo(await client.request("/"), "/login");
  } finally { logoutFailure = false; }
});

test("forged session cookies cannot authenticate a user", async () => {
  const client = browser();
  client.jar.set("nexo-pos-auth", `base64-${Buffer.from(JSON.stringify({ access_token: "forged", refresh_token: "fake", expires_at: 9999999999, user: users.get("admin@example.test").user })).toString("base64url")}`);
  redirectTo(await client.request("/"), "/login");
  assert.equal(client.jar.size, 0);
});
