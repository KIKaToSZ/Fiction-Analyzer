#!/usr/bin/env node
/**
 * 飞书 OpenAPI 本地代理（仅用于本地开发，绕开浏览器 CORS 拦截）
 *
 * 背景：浏览器从第三方页面（含 IGA Pages 静态站点）直接调
 *   https://open.feishu.cn/open-apis/*
 * 会被 CORS 拦截（飞书 OpenAPI 不返回 Access-Control-Allow-Origin 头），
 * 表现为 fetch 失败、错误信息是 "Failed to fetch"，无法用代码绕过。
 *
 * 这个代理起在本机（默认端口 8787），把请求：
 *   http://localhost:8787/api/feishu/<path>
 * 转发到
 *   https://open.feishu.cn/open-apis/<path>
 * 并在响应里补上 CORS 头。Secret 始终留在浏览器（不写在这里），本服务
 * 只是透传，不会记录任何 Authorization / 请求体。
 *
 * 用法：
 *   node proxy/feishu-proxy.js            # 默认 8787
 *   node proxy/feishu-proxy.js --port 9000
 *
 * 前端约定：
 *   - 默认代理地址：http://localhost:8787/api/feishu
 *   - 路径：去掉前缀 /api/feishu，再加上 https://open.feishu.cn/open-apis
 *
 * 关闭：Ctrl + C
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

// ---- 解析 CLI 参数 ----
const args = process.argv.slice(2);
let port = 8787;
let bindHost = "127.0.0.1"; // 默认只绑本机，避免被同网段其它设备访问
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    const p = parseInt(args[i + 1], 10);
    if (Number.isFinite(p) && p > 0 && p < 65536) port = p;
    i++;
  } else if (args[i] === "--host" && args[i + 1]) {
    bindHost = args[i + 1];
    i++;
  }
}

const ALLOWED_UPSTREAM_HOST = "open.feishu.cn";
const TARGET_PATH_PREFIX = "/open-apis";
const PROXY_PATH_PREFIX = "/api/feishu";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // 仅允许转发到白名单路径前缀，避免被当成开放代理滥用
  let u;
  try {
    u = new URL(req.url, `http://localhost:${port}`);
  } catch (e) {
    return sendJson(res, 400, { error: "bad_request", message: e.message });
  }
  if (
    !u.pathname.startsWith(PROXY_PATH_PREFIX + "/") &&
    u.pathname !== PROXY_PATH_PREFIX
  ) {
    return sendJson(res, 404, {
      error: "not_found",
      hint: `use ${PROXY_PATH_PREFIX}/<path>`,
    });
  }

  // 路径映射：/api/feishu/x/y -> /open-apis/x/y
  const tail = u.pathname.slice(PROXY_PATH_PREFIX.length); // 保留 '/'
  const target = new URL(
    TARGET_PATH_PREFIX + tail + u.search,
    `https://${ALLOWED_UPSTREAM_HOST}`
  );
  if (
    target.hostname !== ALLOWED_UPSTREAM_HOST ||
    !target.pathname.startsWith(TARGET_PATH_PREFIX)
  ) {
    return sendJson(res, 400, {
      error: "forbidden",
      message: "only open.feishu.cn is allowed",
    });
  }

  // 收集 body
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      Accept: req.headers["accept"] || "application/json",
      "User-Agent": "fiction-analyzer-feishu-proxy/1.0",
    };
    if (req.headers["authorization"]) {
      headers["Authorization"] = req.headers["authorization"];
    }

    const preq = https.request(
      {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        timeout: 20000,
      },
      (pres) => {
        res.writeHead(pres.statusCode, {
          "Content-Type":
            pres.headers["content-type"] || "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        pres.pipe(res);
      }
    );

    preq.on("error", (e) => {
      console.error("[feishu-proxy] upstream error:", e.message);
      if (!res.headersSent) {
        sendJson(res, 502, { error: "upstream_error", message: e.message });
      } else {
        res.destroy(e);
      }
    });
    preq.on("timeout", () => {
      preq.destroy(new Error("upstream timeout (20s)"));
    });
    if (body.length) preq.write(body);
    preq.end();
  });
  req.on("error", (e) => {
    console.error("[feishu-proxy] client error:", e.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "client_error", message: e.message });
    }
  });
});

server.listen(port, bindHost, () => {
  const banner = [
    "",
    "  飞书 OpenAPI 本地代理已启动",
    `  监听地址: http://${bindHost}:${port}`,
    `  转发规则: ${PROXY_PATH_PREFIX}/*  ->  https://${ALLOWED_UPSTREAM_HOST}${TARGET_PATH_PREFIX}/*`,
    `  允许方法: GET, POST, PUT, DELETE, OPTIONS`,
    `  允许域名: 仅 ${ALLOWED_UPSTREAM_HOST}（其它请求会被拒绝）`,
    "",
    "  前端使用：把请求地址改成 http://localhost:" + port + PROXY_PATH_PREFIX,
    "  按 Ctrl + C 停止",
    "",
  ];
  console.log(banner.join("\n"));
});

// 优雅关闭
function shutdown(sig) {
  console.log(`\n[feishu-proxy] ${sig} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
