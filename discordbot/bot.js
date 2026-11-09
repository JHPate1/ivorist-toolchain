#!/usr/bin/env node
/* =========================================================
   IVORIST DISCORD BOT (AWS or any Linux host, 24/7)
   Owns the gateway session, handles slash commands, FORMS
   (Discord modals) and file drops, and enqueues every
   submission into the Cloudflare queue. Execution happens
   on this PC via the runner.

   Flows:
     /create  -> modal form -> bind -> user replies with files
                (zip or raw files/images) -> auto-wrapped and queued
     /project -> modal form -> text-only page generated on the site
     /change  -> modal form -> bind -> reply with any files
     /bank    -> modal form -> request logged (bank launches soon)
     zip drop -> ad-hoc submission (zip channels keep working)

   - gateway: connect, heartbeat, resume, reconnect
   - message content: fetched via REST (no privileged intent needed)
   ========================================================= */

import WebSocket from "ws";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUBDOMAIN_RE, RESERVED_SUBDOMAINS, LIMITS } from "../rules.js";
import { createZipStore } from "./zipstore.js";

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

const TYPE_BY_COMMAND = { create: "app", project: "project", change: "change", bank: "bank" };
const CHANNEL_VAR = { app: "app", project: "project", change: "change", bank: "bank" };
const TYPE_LABEL = { app: "Web app deploy", project: "Site project", change: "Site change", bank: "Ivorist Bank" };

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
            "X-Job": JSON.stringify(meta),
            ...(bytes ? { "Content-Type": "application/zip" } : {})
        },
        body: bytes || undefined
    });
    let data = {};
    try {
        data = await res.json();
    } catch { /* */ }
    return { status: res.status, ok: res.ok, data };
}

async function workerPost(route, body, headers) {
    const res = await fetch(config.workerBase + route, {
        method: "POST",
        headers: { ...workerHeaders(), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
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

function userTagOf(interaction) {
    return interaction.member?.user?.username || interaction.user?.username || "unknown";
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

/* =========================================================
    Modals ("forms")
   ========================================================= */

const MODALS = {
    create: {
        title: "Create a web app",
        fields: [
            { id: "subdomain", label: "Subdomain (3-32 chars, a-z 0-9 -)", required: true, ml: 32, placeholder: "my-tool" },
            { id: "name", label: "Project name", required: true, ml: 60 },
            { id: "description", label: "What does it do?", style: 2, ml: 1000 },
            { id: "envtext", label: "Env vars (KEY=value lines, optional)", style: 2, ml: 1000, placeholder: "API_URL=https://api.example.com" }
        ]
    },
    project: {
        title: "Create a project",
        fields: [
            { id: "name", label: "Project name", required: true, ml: 60 },
            { id: "summary", label: "One-line summary (shown on site)", required: true, style: 2, ml: 300 },
            { id: "category", label: "Category (Software/Research/…)", ml: 40 },
            { id: "tech", label: "Technologies (comma separated)", ml: 200 },
            { id: "description", label: "Full walkthrough / details", style: 2, ml: 2000 }
        ]
    },
    change: {
        title: "Propose a site change",
        fields: [
            { id: "summary", label: "What should change?", required: true, style: 2, ml: 300 },
            { id: "note", label: "Extra details for the team", style: 2, ml: 1000 }
        ]
    },
    bank: {
        title: "Ivorist Bank request",
        fields: [
            { id: "account", label: "Account / purpose", required: true, ml: 100 },
            { id: "amount", label: "Amount (optional)", ml: 40 },
            { id: "note", label: "Details (optional)", style: 2, ml: 1000 }
        ]
    }
};

function openModal(command) {
    const def = MODALS[command];
    return {
        type: 9,
        data: {
            custom_id: `ivorist:${command}`,
            title: def.title.slice(0, 45),
            components: def.fields.map((f) => ({
                type: 1,
                components: [{
                    type: 4,
                    custom_id: f.id,
                    label: f.label.slice(0, 45),
                    style: f.style || 1,
                    required: !!f.required,
                    max_length: f.ml || 100,
                    ...(f.placeholder ? { placeholder: f.placeholder.slice(0, 100) } : {})
                }]
            }))
        }
    };
}

function modalValues(interaction) {
    const map = {};
    for (const row of interaction.data?.components || []) {
        for (const field of row.components || []) {
            map[field.custom_id] = String(field.value ?? "").trim();
        }
    }
    return map;
}

function briefError(res) {
    const raw = res.data && res.data.error ? res.data.error : `HTTP ${res.status}`;
    return String(raw).slice(0, 180);
}

/* =========================================================
    Gateways & handlers
   ========================================================= */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 | (1 << 9); // GUILDS + GUILD_MESSAGES (content read via REST)

let ws = null;
let heartbeatTimer = null;
let seq = null;
let sessionId = null;
let heartbeatAcked = true;
let reconnectBackoff = 2000;

function opsChannels() {
    return new Set([
        config.channels.app,
        config.channels.project,
        config.channels.change,
        config.channels.bank
    ]);
}

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
        const channel = d.channel_id;
        const author = d.author?.id;
        if (opsChannels().has(channel) && author && !d.author?.bot) {
            handleChannelMessage(d).catch((error) => {
                console.error("message handling failed:", String(error).slice(0, 300));
            });
        }
    }
}

/* ---- responses ---- */

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
    const ok = await respondCallback(interaction, { type: 4, data: { content, embeds } });
    if (!ok) {
        console.error("reply failed");
    }
    return ok;
}

/* ==================== interaction routing ==================== */

async function handleInteraction(interaction) {
    if (interaction.type === 5) {
        // MODAL_SUBMIT
        if (!String(interaction.data?.custom_id || "").startsWith("ivorist:")) {
            return;
        }
        return handleModalSubmit(interaction);
    }
    if (interaction.type !== 2 || !interaction.data?.name) {
        return;
    }
    const name = interaction.data.name;
    const options = interaction.data?.options || [];
    const optsMap = {};
    for (const o of options) {
        optsMap[o.name] = o.value;
    }

    if (MODALS[name]) {
        // submission commands open their form
        return respondCallback(interaction, openModal(name));
    }

    if (name === "ping") {
        await deferInteraction(interaction);
        let health = {};
        try {
            health = (await workerJson("/healthz")).data || {};
        } catch { /* */ }
        return followup(interaction, {
            content:
                `🟢 bot (this server): online\n` +
                `🟡 cloud queue: ${config.workerBase}\n` +
                `● runner (build machine): ${health.runner === "online" ? "online — jobs execute immediately" : "offline — jobs queue until it is back"}\n` +
                `● discord integration: ${health.discord || "?"}`
        });
    }

    if (name === "apps") {
        await deferInteraction(interaction);
        const res = await workerJson("/runner/apps");
        const apps = res.ok ? (res.data || []).slice(-20).reverse() : null;
        if (!res.ok) {
            return followup(interaction, { content: `⛔ could not read the app registry (HTTP ${res.status})` });
        }
        if (!apps.length) {
            return followup(interaction, { content: "📭 no web apps deployed yet — run `/create` in <#" + config.channels.app + ">" });
        }
        return followup(interaction, {
            embeds: [{
                title: "Deployed web apps",
                color: 0x2f6b49,
                fields: apps.map((a) => ({ name: a.slug, value: `<${a.url}> • branch \`${a.branch}\``, inline: false }))
            }]
        });
    }

    if (name === "status") {
        await deferInteraction(interaction);
        const id = optsMap.job_id || (await workerJson("/runner/jobs")).data?.[0]?.id;
        if (!id) {
            return followup(interaction, { content: "ℹ no such job" });
        }
        const res = await workerJson(`/runner/job/${encodeURIComponent(String(id).trim())}`);
        if (!res.ok) {
            return followup(interaction, { content: `⛔ could not read job \`${id}\` (HTTP ${res.status})` });
        }
        return followup(interaction, { embeds: [jobToEmbed(res.data)] });
    }

    if (name === "log") {
        await deferInteraction(interaction);
        const res = await workerJson("/runner/jobs");
        if (!res.ok) {
            return followup(interaction, { content: `⛔ could not read the job log (HTTP ${res.status})` });
        }
        const jobs = res.data || [];
        if (!jobs.length) {
            return followup(interaction, { content: "📭 no jobs yet. Use `/create`, `/project`, `/change` or `/bank`." });
        }
        return followup(interaction, {
            embeds: [{
                title: "Recent jobs",
                color: 0x2f6b49,
                fields: jobs.slice(0, 10).map((j) => ({
                    name: `${j.id} — ${j.title}`,
                    value: `${TYPE_LABEL[j.type] || j.type} • **${j.status}** • by ${j.userTag} • <t:${Math.floor(j.createdAt / 1000)}:R>`,
                    inline: false
                }))
            }]
        });
    }

    return replyContent(interaction, `⁉ unknown command: ${name}`);
}

function jobToEmbed(job) {
    const icons = { pending: "○", active: "◐", done: "✔", failed: "✖" };
    const lines = job.steps ? Object.entries(job.steps).map(([n, s]) => `${icons[s.state] || s.icon} ${n}${s.detail ? " — " + s.detail : ""}`) : [];
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
    if (job.type === "bank") {
        fields.length = 0;
        fields.push(
            { name: "STATUS", value: `**${String(job.status).toUpperCase()}** — request received, the bank launches soon`, inline: false },
            {
                name: "REQUEST",
                value: [job.account ? `account: ${job.account}` : "", job.amount ? `amount: ${job.amount}` : "", job.note || ""].filter(Boolean).join("\n") || "(no details)",
                inline: false
            }
        );
    }
    return {
        title: `${job.status === "done" ? "🟢" : ["failed", "rejected"].includes(job.status) ? "🔴" : "🟡"} ${TYPE_LABEL[job.type] || job.type} — ${job.title || job.id}`,
        color: job.status === "done" ? 0x4ade80 : ["failed", "rejected"].includes(job.status) ? 0xb91c1c : job.status === "parked" ? 0x2f6b49 : 0xf59e0b,
        fields,
        footer: { text: `Ivorist Ops • job ${job.id} • by ${job.userTag}` }
    };
}

/* ==================== form submissions ==================== */

async function bindUserToJob(userId, jobId, type, minutes) {
    return workerPost("/runner/bind", { userId, jobId, type, ttlMinutes: minutes });
}

async function handleModalSubmit(interaction) {
    const command = String(interaction.data.custom_id).replace("ivorist:", "");
    const v = modalValues(interaction);
    const userTag = userTagOf(interaction);
    const userId = interaction.member?.user?.id || interaction.user?.id;

    if (command === "create") {
        const slug = slugChecks(v.subdomain);
        if (!slug.ok) {
            return replyContent(interaction, `✖ ${slug.reason}`);
        }
        const meta = {
            type: "app",
            userTag,
            userId,
            fileName: undefined,
            subdomain: slug.subdomain,
            name: v.name || slug.subdomain,
            description: (v.description || "").slice(0, 1000),
            envText: (v.envtext || "").slice(0, 4000) || undefined
        };
        const res = await enqueueSubmission(meta, null);
        if (!res.ok) {
            return replyContent(interaction, `⛔ the queue rejected the form: \`${briefError(res)}\``);
        }
        const jobId = res.data?.jobId;
        await bindUserToJob(userId, jobId, "app", 30);
        return replyContent(interaction,
            `🧾 job \`${jobId}\` — form accepted for **https://${slug.subdomain}.ivorists.com**\n` +
            `➡ **Now reply in this channel with your files** (a zip, or any files: html, css, js, images…). I will bind the next message you send here to this job.\n` +
            `⏳ 30 minutes. Type \`cancel\` to abandon it.`
        );
    }

    if (command === "project") {
        if (!v.name || !v.summary) {
            return replyContent(interaction, "✖ name and summary are required");
        }
        const meta = {
            type: "project",
            userTag,
            userId,
            textOnly: true,
            name: v.name.slice(0, 60),
            summary: v.summary.slice(0, 300),
            category: (v.category || "Software").slice(0, 40),
            description: (v.description || "").slice(0, 2000),
            technologies: (v.tech || "").slice(0, 200)
        };
        const res = await enqueueSubmission(meta, null);
        if (!res.ok) {
            return replyContent(interaction, `⛔ the queue rejected the form: \`${briefError(res)}\``);
        }
        const jobId = res.data?.jobId;
        return replyContent(interaction,
            `🧾 job \`${jobId}\` — **${meta.name}** was added to the pipeline. No files were attached, so the project page is generated from this form.\n` +
            `Follow the tracker embed in this channel; the site updates at ivorists.com/projects.`
        );
    }

    if (command === "change") {
        if (!v.summary) {
            return replyContent(interaction, "✖ summary is required");
        }
        const meta = {
            type: "change",
            userTag,
            userId,
            fileName: undefined,
            name: v.summary.slice(0, 60),
            summary: v.summary.slice(0, 300),
            note: (v.note || "").slice(0, 1000)
        };
        const res = await enqueueSubmission(meta, null);
        if (!res.ok) {
            return replyContent(interaction, `⛔ the queue rejected the form: \`${briefError(res)}\``);
        }
        const jobId = res.data?.jobId;
        await bindUserToJob(userId, jobId, "change", 30);
        return replyContent(interaction,
            `🧾 job \`${jobId}\` — change request noted: **${meta.summary}**\n` +
            `➡ **Now reply in this channel with the files to change** (any files or images; multiple allowed). I will bind the next message you send here to this job.\n` +
            `⏳ 30 minutes. Type \`cancel\` to abandon it.`
        );
    }

    if (command === "bank") {
        if (!v.account) {
            return replyContent(interaction, "✖ account/purpose is required");
        }
        const meta = {
            type: "bank",
            userTag,
            userId,
            fileName: undefined,
            name: v.account.slice(0, 60),
            account: v.account.slice(0, 100),
            amount: (v.amount || "").slice(0, 40),
            note: (v.note || "").slice(0, 1000)
        };
        const res = await enqueueSubmission(meta, null);
        if (!res.ok) {
            return replyContent(interaction, `⛔ the queue rejected the form: \`${briefError(res)}\``);
        }
        const jobId = res.data?.jobId;
        return replyContent(interaction, null, [{
            title: "Ivorist Bank — request logged",
            color: 0x2f6b49,
            description:
                `🏦 **Ivorist Bank is coming soon.** Your request was stored in the ops log and will be processed when the treasury launches.\n\n` +
                `**account/purpose:** ${meta.account}${meta.amount ? `\n**amount:** ${meta.amount}` : ""}${meta.note ? `\n**details:** ${meta.note}` : ""}\n\n` +
                `job id: \`${jobId}\` • find it any time with \`/log\``,
            footer: { text: "Ivorist Ops" }
        }]);
    }

    return replyContent(interaction, "⁉ unknown form");
}

/* ==================== channel messages (file binding + drops) ==================== */

function safeEntryName(name, used) {
    let base = String(name || "file")
        .split(/[\\/]/)
        .pop()
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 80) || "file.bin";
    if (base === "." || base === "..") {
        base = "_" + base;
    }
    let out = base;
    let n = 1;
    while (used.has(out.toLowerCase())) {
        out = base.replace(/(\.[^.]*|$)/, (ext) => `-${n}${ext}`);
        n += 1;
    }
    used.add(out.toLowerCase());
    return out;
}

async function unbindUser(userId) {
    return workerPost("/runner/unbind", { userId });
}

async function waitFilesAndBind(message) {
    const userId = message.author?.id;
    let bind = null;
    const bindRes = await workerJson(`/runner/bind/${encodeURIComponent(userId)}`);
    bind = bindRes.ok ? bindRes.data : null;
    if (!bind || !bind.jobId) {
        return null;
    }

    const content = String(message.content || "").trim().toLowerCase();
    if (content === "cancel" || content.startsWith("cancel")) {
        await unbindUser(userId);
        await postChannelMessage(message.channel_id, {
            content: `✖ form for job \`${bind.jobId}\` cancelled — the job will expire unused.`
        });
        return "handled";
    }

    const atts = message.attachments || [];
    if (!atts.length) {
        return null; // plain chatter while a form is open
    }

    let total = 0;
    for (const a of atts) {
        total += a.size || 0;
        if ((a.size || 0) > LIMITS.maxZipBytes) {
            await postChannelMessage(message.channel_id, {
                content: `✖ ${a.name} is ${((a.size || 0) / 1048576).toFixed(1)} MB — the cap is ${LIMIT_MB} MB per collection of files.`
            });
            return "handled";
        }
    }
    if (total > LIMITS.maxZipBytes) {
        await postChannelMessage(message.channel_id, {
            content: `✖ ${atts.length} files total ${((total) / 1048576).toFixed(1)} MB — over the ${LIMIT_MB} MB cap. Send fewer or smaller files.`
        });
        return "handled";
    }

    const entries = [];
    const used = new Set();
    for (const a of atts) {
        try {
            const bytes = await downloadAttachment(a);
            entries.push({ name: safeEntryName(a.filename || a.name, used), data: bytes });
        } catch (error) {
            await postChannelMessage(message.channel_id, {
                content: `⛔ could not download ${a.name}: ${String(error).slice(0, 140)}`
            });
            return "handled";
        }
    }

    const zip = createZipStore(entries);
    const res = await fetch(config.workerBase + "/runner/attach", {
        method: "POST",
        headers: {
            ...workerHeaders(),
            "Content-Type": "application/zip",
            "X-Job": JSON.stringify({ jobId: bind.jobId, fileName: `bindings-${bind.jobId}.zip` })
        },
        body: zip
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        await postChannelMessage(message.channel_id, {
            content: `⛔ could not attach ${entries.length} file(s) to \`${bind.jobId}\`: \`${String(errText).slice(0, 160)}\``
        });
        return "handled";
    }
    await unbindUser(userId);
    await postChannelMessage(message.channel_id, {
        content: `📦 ${entries.length} file(s) bound to job \`${bind.jobId}\` — pipeline started, follow the tracker in this channel.`
    });
    return "handled";
}

/* ---- ad-hoc zip drops (no form; still supported) ---- */

function slugFromFilename(base) {
    return String(base || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function handleChannelMessage(message) {
    // 0) the gateway payload may lack attachments/content (no privileged
    //    intent on this bot): fetch the full message over REST instead.
    let msg = message;
    if (!Array.isArray(msg.attachments) || typeof msg.content !== "string") {
        const res = await discord("GET", `/channels/${msg.channel_id}/messages/${msg.id}`);
        if (!res.ok || !res.data) {
            return;
        }
        msg = res.data;
        if (msg.author?.bot) {
            return;
        }
    }

    const typeByChannel = {
        [config.channels.app]: "app",
        [config.channels.project]: "project",
        [config.channels.change]: "change"
    };
    const type = typeByChannel[msg.channel_id];

    // 1) bound delivery for an open form
    const hasFiles = (msg.attachments || []).length > 0;
    if (msg.author?.id && (hasFiles || String(msg.content || "").toLowerCase().startsWith("cancel"))) {
        try {
            const handled = await waitFilesAndBind(msg);
            if (handled === "handled") {
                return;
            }
        } catch (error) {
            console.error("bind flow failed:", String(error).slice(0, 200));
        }
    }

    // 2) ad-hoc zip drop
    if (!type || !hasFiles) {
        return;
    }
    const att = (msg.attachments || []).find((a) => String(a.name || "").toLowerCase().endsWith(".zip"));
    if (!att) {
        await postChannelMessage(msg.channel_id, {
            content: `ℹ to submit **${TYPE_LABEL[type]}s** without a zip, run \`/${type === "app" ? "create" : type}\` first — the form binds your next message with any files.`
        });
        return;
    }
    if ((att.size || 0) > LIMITS.maxZipBytes) {
        await postChannelMessage(msg.channel_id, {
            content: `✖ ${att.name} is ${((att.size || 0) / 1048576).toFixed(1)} MB — the cap is ${LIMIT_MB} MB. Use a smaller zip.`
        });
        return;
    }

    const base = String(att.name).replace(/\.zip$/i, "").toLowerCase();
    const meta = {
        type,
        userTag: msg.author?.username || "unknown",
        fileName: att.name
    };

    if (type === "app") {
        const slug = slugFromFilename(base);
        const check = slugChecks(slug);
        if (!check.ok) {
            await postChannelMessage(msg.channel_id, {
                content: `✖ "${base}" is not a usable subdomain (3-32 chars, a-z0-9-). Run \`/create\` and fill the form instead.`
            });
            return;
        }
        meta.subdomain = check.subdomain;
        meta.name = base;
        meta.description = String(msg.content || "").slice(0, 400) || `zip dropped in <#${msg.channel_id}>`;
    } else if (type === "project") {
        meta.name = base;
        meta.category = "Software";
        meta.summary = `project submitted via zip drop ${base}`;
        meta.description = String(msg.content || "").slice(0, 400);
    } else {
        meta.name = base;
        meta.summary = String(msg.content || "").slice(0, 300) || `change submitted via zip drop ${base}`;
    }

    let bytes;
    try {
        bytes = await downloadAttachment(att);
    } catch (error) {
        await postChannelMessage(msg.channel_id, { content: `⛔ could not download ${att.name}: ${String(error).slice(0, 120)}` });
        return;
    }

    const res = await enqueueSubmission(meta, bytes);
    if (!res.ok) {
        await postChannelMessage(msg.channel_id, { content: `⛔ the queue rejected ${att.name} (HTTP ${res.status})` });
        return;
    }
    await postChannelMessage(msg.channel_id, {
        content: `🧾 job \`${res.data?.jobId}\` queued from the ${TYPE_LABEL[type].toLowerCase()} drop — tracker embed follows.`
    });
}

/* ==================== boot ==================== */

process.on("unhandledRejection", (error) => {
    console.error("unhandled rejection:", String(error).slice(0, 300));
});

connect();
console.log(`ivorist bot booting — worker ${config.workerBase}`);

setInterval(() => {
    // keeps the node event loop warm on idle servers
}, 60000);
