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
let authFailure = null;
let logoutFailure = false;
let app;
let origin;
let appOutput = "";
const registerId = "10000000-0000-4000-8000-000000000001";
const registerSessions = [];

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
    if (authFailure) return send(authFailure.status, authFailure.body);
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
    if (profileFailure) return send(profileFailure.status ?? 503, profileFailure.body ?? { message: "Unavailable" });
    if (!record || url.searchParams.get("id") !== `eq.${record.user.id}`) return send(403, { message: "Forbidden" });
    return send(200, record.profile ? [record.profile] : []);
  }
  if (url.pathname === "/rest/v1/pos_register_sessions") return send(200, registerSessions.filter((s) => s.cashier_id === record?.user.id));
  if (url.pathname === "/rest/v1/pos_registers") return send(200, [{ id: registerId, name: "მთავარი სალარო", active: true }]);
  if (["/rest/v1/pos_business_customers", "/rest/v1/pos_customer_prices", "/rest/v1/pos_sales", "/rest/v1/pos_customer_transactions"].includes(url.pathname)) return send(200, []);
  if (url.pathname === "/rest/v1/pos_payment_methods") return send(200, [{code:"cash", name:"ნაღდი", active:true}]);
  if (["/rest/v1/rpc/pos_open_register", "/rest/v1/rpc/pos_close_register"].includes(url.pathname)) {
    if (!record) return send(401, {});
    let body = "";
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    if (url.pathname.endsWith("pos_open_register")) {
      const id = "20000000-0000-4000-8000-000000000001";
      registerSessions.push({id, register_id:registerId,cashier_id:record.user.id,opened_at:new Date().toISOString(),opening_cash:args.p_cash,status:"open",expected_closing_cash:null,actual_closing_cash:null,cash_difference:null});
      return send(200,id);
    }
    const session = registerSessions.find((s) => s.id === args.p_session);
    Object.assign(session,{status:"closed",expected_closing_cash:session.opening_cash,actual_closing_cash:args.p_actual,cash_difference:"0.00"});
    return send(200,session.opening_cash);
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
    async submit(path, values = {}, formIndex = 0) {
      const page = await this.request(path);
      assert.equal(page.status, 200);
      const html = await page.text();
      const action = [...html.matchAll(/name="(\$ACTION_ID_[^"]+)"/g)][formIndex];
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

function diagnosticsSince(offset) {
  return [...appOutput.slice(offset).matchAll(/\[nexo-pos-auth\] (\{[^\r\n]+\})/g)]
    .map((match) => JSON.parse(match[1]));
}

test("Auth API 401 identifies the password sign-in step without logging the key", async () => {
  const offset = appOutput.length;
  authFailure = { status: 401, body: { message: "Invalid API key", secret: "DO_NOT_LOG_THIS_KEY" } };
  try {
    redirectTo(await browser().login("admin"), "/login?error=unavailable");
    const events = diagnosticsSince(offset);
    const failure = events.find((entry) => entry.source === "login" && entry.step === "signInWithPassword" && entry.outcome === "failed");
    assert.ok(failure);
    assert.equal(failure.error.status, 401);
    assert.equal(failure.error.category, "invalid_api_key");
    assert.ok(events.some((entry) => entry.source === "middleware" && entry.step === "login.request"));
    assert.ok(!appOutput.slice(offset).includes("DO_NOT_LOG_THIS_KEY"));
  } finally { authFailure = null; }
});

for (const [status, code] of [[403, "42501"], [404, "PGRST205"], [400, "42703"]]) {
  test(`profile failure ${code} is logged separately after successful Auth`, async () => {
    const offset = appOutput.length;
    profileFailure = { status, body: { code, message: "private upstream details DO_NOT_LOG_PROFILE_SECRET", details: "private", hint: "private" } };
    try {
      redirectTo(await browser().login("admin"), "/login?error=unavailable");
      const events = diagnosticsSince(offset);
      const failure = events.find((entry) => entry.source === "login" && entry.step === "pos_profiles.select" && entry.outcome === "failed");
      assert.ok(failure);
      assert.equal(failure.error.code, code);
      assert.equal(failure.error.status, status);
      assert.ok(events.some((entry) => entry.attemptId === failure.attemptId && entry.step === "signInWithPassword" && entry.outcome === "success"));
      assert.ok(events.some((entry) => entry.attemptId === failure.attemptId && entry.step === "getUser" && entry.outcome === "success"));
      assert.ok(!appOutput.slice(offset).includes("DO_NOT_LOG_PROFILE_SECRET"));
    } finally { profileFailure = false; }
  });
}

test("middleware profile failures on /login identify middleware as the source", async () => {
  const client = browser();
  redirectTo(await client.login("admin"), "/");
  const offset = appOutput.length;
  profileFailure = { status: 403, body: { code: "42501", message: "permission denied" } };
  try {
    redirectTo(await client.request("/login"), "/login?error=unavailable");
    assert.equal(client.jar.size, 0);
    assert.ok(diagnosticsSince(offset).some((entry) => entry.source === "middleware" && entry.step === "pos_profiles.select" && entry.error?.code === "42501"));
  } finally { profileFailure = false; }
});

test("successful redirects are not diagnosed as sign-in exceptions; logs exclude credentials", async () => {
  const offset = appOutput.length;
  redirectTo(await browser().login("admin"), "/");
  const events = diagnosticsSince(offset).filter((entry) => entry.source === "login");
  assert.ok(events.some((entry) => entry.step === "cookies.write" && entry.outcome === "success"));
  assert.ok(events.some((entry) => entry.step === "login.result" && entry.outcome === "success"));
  assert.ok(!events.some((entry) => entry.outcome === "failed"));
  const logs = appOutput.slice(offset);
  for (const secret of ["admin@example.test", "test-password", "test-anon-key-not-a-secret", "test-signature", "refresh-00000000"]) {
    assert.ok(!logs.includes(secret), "Auth logs must exclude credentials and identifiers");
  }
});

test("Phase 1 admin screens render while cashier direct access is denied", async () => {
  const admin = browser(), cashier = browser();
  redirectTo(await admin.login("admin"), "/");
  redirectTo(await cashier.login("cashier"), "/");
  for (const [path,title] of [["/customers","ბიზნეს კლიენტები"],["/registers","სალაროების მართვა"],["/payment-methods","გადახდის მეთოდები"]]) {
    const page = await admin.request(path);
    assert.equal(page.status,200);
    assert.ok((await page.text()).includes(title));
    const denied = await cashier.request(path);
    const body = await denied.text();
    assert.ok([303,307].includes(denied.status) || body.includes("NEXT_REDIRECT"));
    assert.ok(!body.includes("$ACTION_ID_" + "undefined"));
  }
});

test("cashier can submit opening and closing forms and see session history", async () => {
  const client = browser();
  redirectTo(await client.login("cashier"), "/");
  redirectTo(await client.submit("/",{register_id:registerId,opening_cash:"25.00"},1),"/?saved=1");
  const html = await (await client.request("/")).text();
  assert.ok(html.includes("მიმდინარე სესია"));
  redirectTo(await client.submit("/",{session_id:registerSessions[0].id,actual_cash:"25.00",note:"დათვლილია"},1),"/?saved=1");
  const closed = await (await client.request("/")).text();
  assert.ok(closed.includes("დახურული"));
  assert.ok(closed.includes("სალაროს გახსნა"));
});
