// start.js — 读取 .env 并启动后端
import { readFileSync } from "fs";
import { spawn } from "child_process";

// 简单 .env 解析
const envContent = readFileSync(new URL("./.env", import.meta.url), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
}

const server = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit"
});

server.on("exit", (code) => process.exit(code ?? 0));
