// Exercise the real Pi extension loader and runner without a Zalo token or model API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const entry = process.env.PI_TEST_BIN ?? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

test("Pi routes Zalo commands, dialogs and prompts before and after reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zalo-smoke-"));
  const updates = [];
  const messages = [];
  const events = [];
  let nextId = 0;
  let polls = 0;
  let stderr = "";
  let pi;
  let exit;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let result;
    if (req.url === "/bot-smoke/getUpdates") {
      polls++;
      if (updates.length === 0) await delay(40);
      if (res.destroyed) return; // A stopped poll must not consume the next update.
      result = updates.shift() ?? [];
    } else if (req.url === "/bot-smoke/sendMessage") {
      messages.push(JSON.parse(body));
      result = { message_id: `sent-${messages.length}` };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.end(JSON.stringify({ ok: true, result }));
  });
  const sendZalo = (text) => {
    const id = `incoming-${++nextId}`;
    updates.push({
      event_name: "message.text.received",
      message: { message_id: id, chat: { id: "chat" }, from: { id: "paired-user" }, text },
    });
    return id;
  };
  const waitFor = async (label, check) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && pi.exitCode === null && pi.signalCode === null) {
      const result = check();
      if (result) return result;
      await delay(30);
    }
    const logsDir = join(dir, "logs");
    const logs = await readdir(logsDir).catch(() => []);
    const log = logs.find((name) => name.startsWith("pi-zalo-plus-"));
    const logTail = log ? (await readFile(join(logsDir, log), "utf8")).trim().split("\n").slice(-15).join("\n") : "";
    assert.fail(`${label} not observed after ${polls} polls. Pi stderr: ${stderr}\nEvents: ${JSON.stringify(events.slice(-20))}\nZalo: ${JSON.stringify(messages.slice(-20))}\nExtension log:\n${logTail}`);
  };
  const waitForMessage = (text, replyTo) => waitFor(text, () => messages.find(
    (message) => message.chat_id === "chat" && message.reply_to_message_id === replyTo && message.text.includes(text),
  ));

  try {
    const config = join(dir, "zalo.json");
    await writeFile(config, JSON.stringify({ bot_token: "-smoke", bot_name: "Mock bot", allowed_user_id: "paired-user" }));
    const fixture = join(dir, "smoke-extension.ts");
    await writeFile(fixture, `export default function (pi) {
      pi.registerCommand("smoke-reload", { handler: async (_args, ctx) => ctx.reload() });
      pi.registerCommand("smoke-local", { handler: async (_args, ctx) => ctx.ui.notify("Local notification", "info") });
      pi.registerCommand("smoke-quit", { handler: async (_args, ctx) => ctx.shutdown() });
      pi.on("session_start", (event, ctx) => {
        if (event.reason === "reload") ctx.ui.notify("Reload finished", "info");
      });
      pi.on("input", (event, ctx) => {
        if (!event.text.startsWith("smoke prompt ")) return;
        ctx.ui.notify("Pi received " + event.text, "info");
        return { action: "handled" };
      });
    }`);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_ZALO_API_ROOT: `http://127.0.0.1:${server.address().port}/bot` };
    delete env.PI_AGENT_DIR;
    pi = spawn(process.execPath, [entry, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", fixture], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    exit = once(pi, "exit");
    pi.stderr.on("data", (chunk) => { stderr += chunk; });
    createInterface({ input: pi.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.method !== "setStatus") events.push(event);
      } catch { stderr += `${line}\n`; }
    });

    const dialog = sendZalo("/zalo-config");
    await waitForMessage("Zalo Config", dialog);
    const rpcPrompt = (id, message) => pi.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    rpcPrompt("local", "/smoke-local");
    await waitFor("local notification", () => events.find((event) =>
      event.type === "extension_ui_request" && event.method === "notify" && event.message === "Local notification"));
    assert.ok(!messages.some((message) => message.text.includes("Local notification")));
    sendZalo("3"); // Message mode
    await waitForMessage("Message mode", dialog);
    await delay(50); // Let Pi receive the outgoing dialog receipt before answering.
    sendZalo("1"); // Queue
    await waitForMessage("set to queue");
    assert.equal(JSON.parse(await readFile(config, "utf8")).message_mode, "queue");
    sendZalo("smoke prompt before reload");
    await waitForMessage("Pi received smoke prompt before reload");

    rpcPrompt("reload", "/smoke-reload");
    const reload = await waitFor("Pi reload response", () => events.find((event) => event.type === "response" && event.id === "reload"));
    assert.equal(reload.success, true, JSON.stringify(reload));
    await waitFor("reload session_start", () => events.find((event) => event.message === "Reload finished"));
    const beforePoll = polls;
    await waitFor("polling after reload", () => polls > beforePoll);
    sendZalo("/zalo-config mode steer");
    await waitForMessage("mode set to steer");
    sendZalo("smoke prompt after reload");
    await waitForMessage("Pi received smoke prompt after reload");
    sendZalo("/smoke-quit");
    await waitForMessage("Remote shutdown blocked");
    assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
  } finally {
    if (pi) {
      pi.stdin.end();
      const kill = setTimeout(() => pi.kill("SIGKILL"), 3_000);
      try { await exit; } finally { clearTimeout(kill); }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { force: true, recursive: true });
  }
});
