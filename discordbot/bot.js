#!/usr/bin/env node
/* =========================================================
   IVORIST DISCORD BOT (AWS / any Linux host)
   Holds the 24/7 gateway session, handles slash commands and
   zip drops, and enqueues every submission into the Cloudflare
   queue. No job execution here: the runner (this PC) does that.

   - gateway: connect, heartbeat, resume, reconnect
   - interactions: /create /project /change /bank /apps /status /log /ping
   - channel drops: message with a .zip in an ops channel
   - REST: interaction callbacks + channel notes via the bot token
   ========================================================= */

import WebSocket from "ws";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUBDOMAIN_RE, RESERVED_SUBDOMAINS, LIMITS } from "../rules.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));

function readConfigStrict(file) {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    return JSON.parse(text);
}

const DISCORD_API = "https://discord.com/api/v10";
const LIMIT_MB = Math.round(LIMITS.maxZipBytes / 1048576);

let config;
try {
    config = readConfigStrict(path.join(HERE, "config.json"));
} catch (error) {
    console.error("config.json missing or invalid:", String(error).slice(0, 200));
    process.exit(1);
}
if (!config.token || config.token === "PASTE_BOT_TOKEN") {
    console.error("token missing in config.json");
    process.exit(1);
}

/* -------------------- Discord REST -------------------- */

async function discord(method, route, body, extraHeaders) {
    const init = {
        method,
        headers: { Authorization: `Bot ${config.token}`, ...(extraHeaders || {}) }
    };
    if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(DISCORD_API + route, init);
    let data = null;
    try {
        data = await res.json();
    } catch { /* empty */ }
    return { status: res.status, ok: res.ok, data };
}

async function respondCallback(interaction, payload) {
    return discord("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, payload);
}

async function followup(interaction, messagePayload) {
    const appId = await appIdentifier();
    return discord("POST", `/webhooks/${appId}/${interaction.token}`, messagePayload);
}

async function postChannelMessage(channelId, payload) {
    return discord("POST", `/channels/${channelId}/messages`, payload);
}

/* -------------------- worker (queue + reads) -------------------- */

function workerHeaders() {
    return {
        Authorization: `Bearer ${config.runnerToken}`,
        "Content-Type": "application/json"
    };
}

async function enqueueSubmission(meta, bytes) {
    const res = await fetch(config.workerBase + "/runner/enqueue", {
        method: "POST",
        headers: {
            ...workerHeaders(),
            "Content-Type": "application/zip",
            "X-Job": JSON.stringify(meta)
        },
        body: bytes
    });
    let data = {};
    try {
        data = await res.json();
    } catch { /* */ }
    return { status: res.status, ok: res.ok, data };
}

async function workerJson(route) {
    const res = await fetch(config.workerBase + route, { headers: workerHeaders() });
    let data = null;
    try {
        data = await res.json();
    } catch { /* */ }
    return { status: res.status, ok: res.ok, data };
}

let cachedAppId = config.applicationId || "";
async function appIdentifier() {
    if (cachedAppId) {
        return cachedAppId;
    }
    const res = await discord("GET", "/oauth2/applications/@me");
    if (res.ok && res.data && res.data.id) {
        cachedAppId = res.data.id;
        console.log("application id:", cachedAppId);
        return cachedAppId;
    }
    throw new Error("could not resolve application id: " + res.status);
}

/* -------------------- submission rules (mirror the worker) -------------------- */

function slugChecks(value) {
    const subdomain = String(value || "").trim().toLowerCase();
    if (!SUBDOMAIN_RE.test(subdomain)) {
        return { ok: false, reason: "subdomain must be 3-32 chars: lowercase letters, numbers, hyphens; must start and end with a letter or number" };
    }
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
        return { ok: false, reason: `subdomain "${subdomain}" is reserved` };
    }
    return { ok: true, subdomain };
}

function attachmentOf(interaction) {
    const options = interaction.data?.options || [];
    const opt = options.find((o) => o.type === 11);
    if (!opt) {
        return null;
    }
    const att = interaction.data.resolved?.attachments?.[opt.value];
    return att || null;
}

function zipIssue(att) {
    if (!att) {
        return "zip file is missing (add a `zip` attachment)";
    }
    if (!String((att.filename || att.name) || "").toLowerCase().endsWith(".zip")) {
        return "attachment must be a .zip";
    }
    if ((att.size || 0) > LIMITS.maxZipBytes) {
        return `zip is ${(att.size / 1048576).toFixed(1)} MB; the cap is ${LIMIT_MB} MB`;
    }
    return null;
}

function optsMap(interaction) {
    const map = {};
    for (const o of interaction.data?.options || []) {
        map[o.name] = o.value;
    }
    return map;
}

/* =========================================================
   Gateways & handlers
   ========================================================= */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 | (1 << 9); // GUILDS + GUILD_MESSAGES

let ws = null;
let heartbeatTimer = null;
let seq = null;
let sessionId = null;
let heartbeatAcked = true;
let reconnectBackoff = 2000;

function gatewaySend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function connect() {
    if (!sessionId) {
        console.log("connecting to the discord gateway");
    } else {
        console.log("resuming gateway session", sessionId);
    }
    let url = GATEWAY_URL;
    if (sessionId && seq != null) {
        url = `${GATEWAY_URL}&session_id=${sessionId}&seq=${seq}`;
    }
    ws = new WebSocket(url, { perMessageDeflate: false });

    ws.on("open", () => {
        reconnectBackoff = 2000;
    });

    ws.on("message", (raw) => {
        let frame;
        try {
            frame = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (frame.s != null) {
            seq = frame.s;
        }
        switch (frame.op) {
            case 10: { // HELLO
                const interval = frame.d?.heartbeat_interval || 41250;
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                }
                heartbeatTimer = setInterval(() => {
                    if (!heartbeatAcked) {
                        try { ws.close(4009, "heartbeat timeout"); } catch { /* */ }
                        return;
                    }
                    heartbeatAcked = false;
                    gatewaySend({ op: 1, d: seq });
                }, interval);
                if (sessionId && seq != null) {
                    gatewaySend({
                        op: 6, // RESUME
                        d: { token: config.token, session_id: sessionId, seq }
                    });
                } else {
                    gatewaySend({
                        op: 2, // IDENTIFY
                        d: {
                            token: config.token,
                            intents: INTENTS,
                            presence: {
                                status: "online",
                                since: Date.now(),
                                activities: [{ name: "Ivorist Ops", type: 0 }],
                                afk: false
                            }
                        }
                    });
                }
                break;
            }
            case 11: { // HEARTBEAT ACK
                heartbeatAcked = true;
                break;
            }
            case 7: // RECONNECT
            case 9: {
                try { ws.close(4000, "server request"); } catch { /* */ }
                break;
            }
            case 0:
                onDispatch(frame.t, frame.d);
                break;
            default:
                break;
        }
    });

    ws.on("close", (code) => {
        console.log(`gateway closed (${code}) — reconnecting in ${reconnectBackoff}ms`);
        if (sessionId) {
            seq = null; // must resume from a fresh seq tracked server-side; drop session politely
            sessionId = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        setTimeout(connect, reconnectBackoff);
        reconnectBackoff = Math.min(reconnectBackoff * 2, 60000);
    });

    ws.on("error", (error) => {
        console.error("gateway ws error:", String(error).slice(0, 200));
        try { ws.close(4000, "error"); } catch { /* */ }
    });
}

function onDispatch(t, d) {
    if (t === "READY") {
        sessionId = d.session_id;
        console.log(`gateway READY — logged in as ${d.user.username}. Bot is online 24/7.`);
        return;
    }
    if (t === "RESUMED") {
        console.log("gateway RESUMED");
        return;
    }
    if (t === "INTERACTION_CREATE") {
        handleInteraction(d).catch((error) => {
            console.error("interaction failed:", String(error).slice(0, 300));
        });
        return;
    }
    if (t === "MESSAGE_CREATE") {
        handleChannelZip(d).catch((error) => {
            console.error("message drop failed:", String(error).slice(0, 300));
        });
    }
}

/* ---- deferred + followup response pattern ---- */

async function deferInteraction(interaction) {
    try {
        await respondCallback(interaction, { type: 5 });
        return true;
    } catch (error) {
        console.error("defer failed:", String(error).slice(0, 200));
        return false;
    }
}

async function replyContent(interaction, content, embeds) {
    // fast path for instant answers
    const ok = await respondCallback(interaction, { type: 4, data: { content, embeds } });
    return ok;
}

/* ==================== slash command handling ==================== */

async function handleInteraction(interaction) {
    if (interaction.type !== 2 || !interaction.data?.name) {
        return;
    }
    const name = interaction.data.name;
    const options = optsMap(interaction);

    if (name === "ping") {
        let health = { runner: "unknown" };
        try {
            health = (await workerJson("/healthz")).data || {};
        } catch { /* */ }
        return replyContent(interaction,
            `🟢 bot (this machine): online\n` +
            `🟡 cloud queue: ${config.workerBase}\n` +
            `● runner (build machine): ${health.runner === "online" ? "online — jobs will execute immediately" : "offline — jobs queue until it is back"}`
        );
    }

    if (name === "bank") {
        if (interaction.channel_id !== config.channels.bank) {
            return replyContent(interaction, "✖ the bank command belongs in <#" + config.channels.bank + ">");
        }
        return replyContent(interaction, null, [{
            title: "Ivorist Bank",
            color: 0x2f6b49,
            description: "🏦 **Ivorist Bank is coming soon.** No jobs are accepted in this channel yet. Rules, checks and the pipeline for this channel ship in a later update.",
            footer: { text: "Ivorist Ops" }
        }]);
    }

    if (name === "apps") {
        const res = await workerJson("/runner/apps");
        const apps = res.ok ? (res.data || []).slice(-20).reverse() : null;
        if (!res.ok) {
            return replyContent(interaction, `⛔ could not read the app registry (HTTP ${res.status})`);
        }
        if (!apps.length) {
            return replyContent(interaction, "📭 no web apps deployed yet — use `/create` in <#" + config.channels.app + ">");
        }
        return replyContent(interaction, null, [{
            title: "Deployed web apps",
            color: 0x2f6b49,
            fields: apps.map((a) => ({ name: a.slug, value: `<${a.url}> • branch \`${a.branch}\``, inline: false }))
        }]);
    }

    if (name === "status") {
        const id = options.job_id || (await workerJson("/runner/jobs")).data?.[0]?.id;
        if (!id) {
            return replyContent(interaction, "ℹ no such job");
        }
        const res = await workerJson(`/runner/job/${encodeURIComponent(String(id).trim())}`);
        if (!res.ok) {
            return replyContent(interaction, `⛔ could not read job \`${id}\` (HTTP ${res.status})`);
        }
        return replyContent(interaction, null, [trackerToEmbed(res.data)]);
    }

    if (name === "log") {
        const res = await workerJson("/runner/jobs");
        if (!res.ok) {
            return replyContent(interaction, `⛔ could not read the job log (HTTP ${res.status})`);
        }
        const jobs = res.data || [];
        if (!jobs.length) {
            return replyContent(interaction, "📭 no jobs yet.");
        }
        return replyContent(interaction, null, [{
            title: "Recent jobs",
            color: 0x2f6b49,
            fields: jobs.slice(0, 10).map((j) => ({
                name: `${j.id} — ${j.title}`,
                value: `${j.type} • **${j.status}** • by ${j.userTag} • <t:${Math.floor(j.createdAt / 1000)}:R>`,
                inline: false
            }))
        }]);
    }

    // create / project / change all share: channel gate, zip gate, enqueue
    if (["create", "project", "change"].includes(name)) {
        await deferInteraction(interaction);
        return handleSubmissionCommand(interaction, name);
    }

    return replyContent(interaction, `⁉ unknown command: ${name}`);
}

function trackerToEmbed(job) {
    const icons = { pending: "○", active: "◐", done: "✔", failed: "✖" };
    const lines = (job.steps || {}) ? Object.entries(job.steps).map(([n, s]) => `${icons[s.state] || s.icon} ${n}${s.detail ? " — " + s.detail : ""}`) : [];
    const fields = [
        { name: "STATUS", value: `**${String(job.status).toUpperCase()}**${job.status === "done" && job.url ? ` → <${job.url}>` : ""}`, inline: false },
        { name: "PIPELINE", value: lines.join("\n").slice(0, 1000) || "(no steps)", inline: false }
    ];
    if (job.error) {
        fields.push({ name: job.status === "rejected" ? "REJECTION REASON" : "ERROR", value: job.error.slice(0, 1000), inline: false });
    }
    if (job.urls && job.urls.length) {
        fields.push({ name: "LIVE", value: job.urls.map((u) => `<${u}>`).join("\n"), inline: false });
    }
    return {
        title: `${job.status === "done" ? "🟢" : ["failed", "rejected"].includes(job.status) ? "🔴" : "🟡"} ${job.type === "app" ? "Web app deploy" : job.type === "project" ? "Site project" : "Site change"} — ${job.title || job.id}`,
        color: job.status === "done" ? 0x4ade80 : ["failed", "rejected"].includes(job.status) ? 0xb91c1c : 0xf59e0b,
        fields,
        footer: { text: `Ivorist Ops • job ${job.id} • by ${job.userTag}` }
    };
}

async function downloadAttachment(att) {
    const url = att.url || att.proxy_url;
    if (!url) {
        throw new Error("attachment has no url");
    }
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`attachment download failed: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

function userTagOf(interaction) {
    return interaction.member?.user?.username || interaction.user?.username || "unknown";
}

async function handleSubmissionCommand(interaction, command) {
    const channelByType = { create: "app", project: "project", change: "change" };
    const type = channelByType[command];
    const expectedChannel = config.channels[type];
    if (expectedChannel && interaction.channel_id !== expectedChannel) {
        await followup(interaction, { content: `✖ \`/${command}\` belongs in <#${expectedChannel}>` });
        return;
    }

    const att = attachmentOf(interaction);
    // upload attachment via MCP-style deferral is not possible here; expect final url
    const attIssue = att ? zipIssue(att) : "zip file is missing (add a `zip` attachment)";
    if (attIssue) {
        await followup(interaction, { content: `✖ ${attIssue}` });
        return;
    }

    let meta = {
        type,
        userTag: userTagOf(interaction),
        fileName: att.filename || att.name
    };

    if (command === "create") {
        const slug = slugChecks(options.subdomain);
        if (!slug.ok) {
            await followup(interaction, { content: `✖ ${slug.reason}` });
            return;
        }
        meta.subdomain = slug.subdomain;
        meta.name = String(options.name || "").slice(0, 60) || slug.subdomain;
        meta.description = String(options.description || "").slice(0, 400);
    } else if (command === "project") {
        if (!options.name || !options.summary) {
            await followup(interaction, { content: "✖ `name` and `summary` are required" });
            return;
        }
        meta.name = String(options.name).slice(0, 60);
        meta.category = String(options.category || "Software").slice(0, 60);
        meta.summary = String(options.summary).slice(0, 400);
        meta.description = String(options.description || "").slice(0, 400);
    } else {
        if (!options.summary) {
            await followup(interaction, { content: "✖ `summary` is required" });
            return;
        }
        meta.name = String(options.summary).slice(0, 60);
        meta.summary = String(options.summary).slice(0, 400);
    }

    let bytes;
    try {
        bytes = await downloadAttachment(att);
    } catch (error) {
        await followup(interaction, { content: `⛔ could not download the attachment: ${String(error).slice(0, 150)}` });
        return;
    }

    const res = await enqueueSubmission(meta, bytes);
    if (!res.ok) {
        await followup(interaction, { content: `⛔ queue rejected the submission (HTTP ${res.status}): \`${String(JSON.stringify(res.data) || "").slice(0, 150)}\`` });
        return;
    }
    const jobId = res.data?.jobId;
    await followup(interaction, {
        content: `🧾 job \`${jobId}\` queued — follow the tracker in this channel`
    });
}

/* ==================== zip drops in channels ==================== */

async function slugFromFilename(base) {
    const str = String(base || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return str;
}

async function handleChannelZip(message) {
    const typeByChannel = {
        [config.channels.app]: "app",
        [config.channels.project]: "project",
        [config.channels.change]: "change"
    };
    const type = typeByChannel[message.channel_id];
    if (!type || (message.attachments || []).length === 0) {
        return;
    }

    const att = (message.attachments || []).find((a) => String(a.name || "").toLowerCase().endsWith(".zip"));
    if (!att) {
        return;
    }
    if ((att.size || 0) > LIMITS.maxZipBytes) {
        await postChannelMessage(message.channel_id, {
            content: `✖ ${att.name} is ${(att.size / 1048576).toFixed(1)} MB — the cap is ${LIMIT_MB} MB. Use a smaller zip.`
        });
        return;
    }

    const base = String(att.name).replace(/\.zip$/i, "").toLowerCase();
    let meta = {
        type,
        userTag: message.author?.username || "unknown",
        fileName: att.name
    };

    if (type === "app") {
        const slug = await slugFromFilename(base);
        const check = slugChecks(slug);
        if (!check.ok) {
            await postChannelMessage(message.channel_id, {
                content: `✖ "${base}" is not a usable subdomain (3-32 chars, a-z0-9-). Resubmit with \`/create subdomain:… name:… zip:…\`.`
            });
            return;
        }
        meta.subdomain = check.subdomain;
        meta.name = base;
        meta.description = (message.content || "").slice(0, 400) || `zip dropped in <#${message.channel_id}>`;
    } else if (type === "project") {
        meta.name = base;
        meta.category = "Software";
        meta.summary = `project submitted via zip drop ${base}`;
        meta.description = (message.content || "").slice(0, 400);
    } else {
        meta.name = base;
        meta.summary = (message.content || "").slice(0, 400) || `change submitted via zip drop ${base}`;
    }

    let bytes;
    try {
        bytes = await downloadAttachment(att);
    } catch (error) {
        await postChannelMessage(message.channel_id, { content: `⛔ could not download ${att.name}: ${String(error).slice(0, 120)}` });
        return;
    }

    const res = await enqueueSubmission(meta, bytes);
    if (!res.ok) {
        await postChannelMessage(message.channel_id, { content: `⛔ the queue rejected ${att.name} (HTTP ${res.status})` });
    }
}

/* ==================== boot ==================== */

process.on("unhandledRejection", (error) => {
    console.error("unhandled rejection:", String(error).slice(0, 300));
});

connect();
console.log(`ivorist bot booting — worker ${config.workerBase}`);

setInterval(() => {
    // keeps node event loop warm on idle servers; no action needed
}, 60000);
