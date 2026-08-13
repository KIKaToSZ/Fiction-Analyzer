// 一体化测试：启动代理 → curl 几次 → 关掉
// 用法：node test-proxy.js
const { spawn } = require("child_process");
const http = require("http");

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;

function req(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const reqOpts = {
      method: opts.method || "GET",
      headers: opts.headers || {},
      timeout: 5000,
    };
    const r = http.request(u, reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

(async () => {
  const child = spawn(process.execPath, ["proxy/feishu-proxy.js", "--port", String(PORT)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let proxyLog = "";
  child.stdout.on("data", (d) => (proxyLog += d));
  child.stderr.on("data", (d) => (proxyLog += d));
  child.on("error", (e) => {
    console.error("spawn error:", e);
    process.exit(1);
  });

  // 等代理就绪
  await new Promise((r) => setTimeout(r, 300));

  let failed = 0;
  const must = (cond, label) => {
    if (cond) {
      console.log(`  ok  ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
      failed++;
    }
  };

  console.log("proxy log:\n" + proxyLog);

  // T1: 根路径 → 404
  {
    const r = await req("/");
    must(r.status === 404, "GET /  → 404");
  }

  // T2: 非 /api/feishu 前缀 → 404
  {
    const r = await req("/foo/bar");
    must(r.status === 404, "GET /foo/bar  → 404");
  }

  // T3: OPTIONS 预检 → 204 + 完整 CORS 头
  {
    const r = await req("/api/feishu/auth/v3/tenant_access_token/internal", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8080",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    must(r.status === 204, "OPTIONS  → 204");
    must(
      r.headers["access-control-allow-origin"] === "*",
      "OPTIONS  Access-Control-Allow-Origin: *"
    );
    must(
      /POST/.test(r.headers["access-control-allow-methods"] || ""),
      "OPTIONS  Access-Control-Allow-Methods 含 POST"
    );
    must(
      /content-type/i.test(r.headers["access-control-allow-headers"] || ""),
      "OPTIONS  Access-Control-Allow-Headers 含 content-type"
    );
  }

  // T4: GET /api/feishu/ → 应该转发到飞书（实际会拿到飞书的 200 或 401，取决于端点）
  // 用 health 类的 GET：/open-apis/health 不存在，用 /api/feishu/ 期望转发到 https://open.feishu.cn/open-apis/ 拿到 redirect 或 404
  {
    const r = await req("/api/feishu/");
    must(r.status >= 200 && r.status < 500, `GET /api/feishu/  → 状态码 ${r.status}（飞书真实响应，2xx/4xx 都算通）`);
    must(
      r.headers["access-control-allow-origin"] === "*",
      "转发响应带 CORS 头"
    );
  }

  // T5: 非法前缀（绕过 /api/feishu/） → 400 forbidden
  {
    const r = await req("/api/feishu/../evil.com/x");
    // URL 解析后 pathname 应该是 /evil.com/x，不在 /api/feishu/ 下
    // 实际依赖 URL 解析：new URL('/api/feishu/../evil.com/x', base) → pathname = '/evil.com/x'
    // 所以应该 404
    must(
      r.status === 404 || r.status === 400,
      `GET /api/feishu/../evil.com/x  → ${r.status}（路径遍历应被拦）`
    );
  }

  // T6: 显式构造一个 POST，body 应当被原样转发
  {
    const r = await req("/api/feishu/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: "cli_test_xxxx", app_secret: "test" }),
    });
    // 飞书真实响应，code 非 0 没关系，body 应该是 JSON
    let bodyOk = false;
    try {
      const j = JSON.parse(r.body);
      bodyOk = typeof j === "object" && j !== null;
    } catch {}
    must(
      r.status === 200 && bodyOk,
      `POST /api/feishu/auth/.../internal  → 200 + JSON body（实际拿到飞书响应）`
    );
    must(
      r.headers["access-control-allow-origin"] === "*",
      "POST 响应也带 CORS 头"
    );
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\nresult: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test error:", e);
  process.exit(2);
});
