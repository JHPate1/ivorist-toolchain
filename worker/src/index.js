import nacl from "tweetnacl";

import {
    bindUser,
    createJob,
    ensureTracker,
    finalizeJob,
    getBind,
    getJob,
    getRunnerAlive,
    listApps,
    listJobs,
    clearAllJobs,
    killJob,
    rest,
    patchJob,
    patchTracker,
    popQueue,
    progress,
    putJob,
    requeueStale,
    reviewJobWithAI,
    setRunnerAlive,
    trackerEmbed,
    unbindUser
} from "./jobs.js";
import { GatewayBot, MODALS, openModal, modalValues } from "./gateway.js";
import { LIMITS, slugChecks, pipelineFor } from "../../rules.js";

export { GatewayBot };

/* =========================================================
   HTTP surface
   ========================================================= */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
            const aliveTs = await getRunnerAlive(env);
            const alive = aliveTs && (Date.now() - aliveTs < 600000);
            let gatewayStatus = "disabled";
            if (env.GATEWAY_ENABLED === "1" && env.GATEWAY) {
                try {
                    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
                    const gRes = await stub.fetch("https://do.internal/ensure");
                    if (gRes.ok) {
                        const gData = await gRes.json();
                        gatewayStatus = gData.active ? "online" : (gData.started ? "connecting" : "idle");
                    } else {
                        gatewayStatus = "error";
                    }
                } catch (e) {
                    gatewayStatus = "error: " + String(e.message || e);
                }
            }
            return json({
                ok: true,
                discord: env.DISCORD_TOKEN && env.DISCORD_TOKEN !== "set-later" ? "ready" : "not configured",
                gateway: gatewayStatus,
                runner: alive ? "online" : "offline"
            });
        }

        if (url.pathname === "/gateway/start" || url.pathname === "/gateway/ensure" || url.pathname === "/gateway/status") {
            if (!env.GATEWAY) {
                return json({ error: "GATEWAY durable object not bound" }, 500);
            }
            const action = url.pathname.replace("/gateway/", "/");
            const stub = env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
            const res = await stub.fetch("https://do.internal" + action);
            const data = await res.json().catch(() => ({}));
            return json(data, res.status);
        }

        if (url.pathname === "/interactions" && request.method === "POST") {
            return interactions(request, env, ctx);
        }

        if (url.pathname.startsWith("/runner/")) {
            if (!authRunner(request, env)) {
                return json({ error: "unauthorized" }, 401);
            }
            return runner(request, env, ctx);
        }

        return json({ error: "not found" }, 404);
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil((async () => {
            try {
                await requeueStale(env);
            } catch (error) {
                console.error("cron requeue:", error);
            }
            if (env.GATEWAY_ENABLED === "1" && env.GATEWAY) {
                try {
                    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
                    await stub.fetch("https://do.internal/ensure");
                } catch (error) {
                    console.error("cron gateway ensure:", error);
                }
            }
        })());
    }
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

function authRunner(request, env) {
    const header = request.headers.get("Authorization") || "";
    return header === `Bearer ${env.RUNNER_TOKEN}`;
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

/* =========================================================
   Discord interactions
   ========================================================= */

const RESPOND = 4;

async function interactions(request, env, ctx) {
    const body = await request.text();
    const sig = request.headers.get("X-Signature-Ed25519") || "";
    const ts = request.headers.get("X-Signature-Timestamp") || "";

    if (!env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY === "set-later") {
        return json({ error: "public key not configured yet" }, 503);
    }
    let ok = false;
    try {
        ok = nacl.sign.detached.verify(
            new TextEncoder().encode(ts + body),
            hexToBytes(sig),
            hexToBytes(env.DISCORD_PUBLIC_KEY)
        );
    } catch (error) {
        ok = false;
    }
    if (!ok) {
        return json({ error: "invalid signature" }, 401);
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
        return json({ type: 1 }); // PING
    }

    // Modal submit (interaction type 5)
    if (interaction.type === 5) {
        let reply;
        try {
            reply = await handleModalSubmit(interaction, env, ctx);
            if (!reply) {
                reply = { content: "…" };
            }
        } catch (error) {
            console.error("modal submit error", error);
            reply = { content: `⛔ form failed: \`${String(error).slice(0, 200)}\`` };
        }
        return json({ type: RESPOND, data: reply });
    }

    // Slash command (interaction type 2)
    if (interaction.type === 2) {
        const name = interaction.data?.name;
        if (MODALS[name]) {
            const channelVar = {
                create: "CHANNEL_APP",
                project: "CHANNEL_PROJECT",
                change: "CHANNEL_CHANGE",
                bank: "CHANNEL_BANK"
            }[name];
            const err = gate(env, interaction, channelVar);
            if (err) {
                return json({ type: RESPOND, data: { content: `✖ ${err}` } });
            }
            return json(openModal(name));
        }

        let reply;
        try {
            reply = await command(interaction, env, ctx);
            if (!reply) {
                reply = { content: "…" };
            }
        } catch (error) {
            console.error("interaction error", error);
            reply = { content: `⛔ command failed: \`${String(error).slice(0, 200)}\`` };
        }

        return json({ type: RESPOND, data: reply });
    }

    return json({ type: 1 });
}

function userTagOf(interaction) {
    return interaction.member?.user?.username || interaction.user?.username || "unknown";
}

function userIdOf(interaction) {
    return interaction.member?.user?.id || interaction.user?.id || "0";
}

async function handleModalSubmit(interaction, env, ctx) {
    const customId = String(interaction.data?.custom_id || "");
    if (!customId.startsWith("ivorist:")) {
        return { content: "⁉ unknown modal" };
    }
    const command = customId.replace("ivorist:", "");
    const v = modalValues(interaction);
    const userTag = userTagOf(interaction);
    const userId = userIdOf(interaction);

    if (command === "create") {
        const slug = slugChecks(v.subdomain);
        if (!slug.ok) {
            return { content: `✖ ${slug.reason}` };
        }
        const res = await createJob(env, ctx, {
            type: "app",
            userTag,
            userId,
            dedupeKey: interaction.id,
            opts: {
                type: "app",
                subdomain: slug.subdomain,
                name: v.name || slug.subdomain,
                description: (v.description || "").slice(0, 1000),
                envText: (v.envtext || "").slice(0, 4000) || undefined
            },
            fileName: null,
            fileBytes: null
        });
        if (res.duplicate) {
            return { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` };
        }
        await bindUser(env, userId, res.jobId, "app", 30);
        return {
            content:
                `🧾 job \`${res.jobId}\` — form queued for **https://${slug.subdomain}.ivorists.com**!\n` +
                `▶ **Pipeline started immediately.** (Optional: reply in this channel with custom files/zip within 30 min to customize the app).`
        };
    }

    if (command === "project") {
        if (!v.name || !v.summary) {
            return { content: "✖ name and summary are required" };
        }
        const res = await createJob(env, ctx, {
            type: "project",
            userTag,
            userId,
            dedupeKey: interaction.id,
            opts: {
                type: "project",
                textOnly: true,
                name: v.name.slice(0, 60),
                summary: v.summary.slice(0, 300),
                category: (v.category || "Software").slice(0, 40),
                description: (v.description || "").slice(0, 2000),
                technologies: (v.tech || "").slice(0, 200)
            },
            fileName: null,
            fileBytes: null
        });
        if (res.duplicate) {
            return { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` };
        }
        return {
            content:
                `🧾 job \`${res.jobId}\` — **${v.name.slice(0, 60)}** entered the pipeline. No files attached: the project page is generated entirely from this form.\n` +
                `Follow the tracker embed in this channel.`
        };
    }

    if (command === "change") {
        if (!v.summary) {
            return { content: "✖ summary is required" };
        }
        const res = await createJob(env, ctx, {
            type: "change",
            userTag,
            userId,
            dedupeKey: interaction.id,
            opts: {
                type: "change",
                name: v.summary.slice(0, 60),
                summary: v.summary.slice(0, 300),
                note: (v.note || "").slice(0, 1000)
            },
            fileName: null,
            fileBytes: null
        });
        if (res.duplicate) {
            return { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` };
        }
        await bindUser(env, userId, res.jobId, "change", 30);
        return {
            content:
                `🧾 job \`${res.jobId}\` — change request queued: **${v.summary.slice(0, 300)}**\n` +
                `▶ **Pipeline started immediately.** (Optional: reply in this channel with custom files to apply).`
        };
    }

    if (command === "bank") {
        if (!v.account) {
            return { content: "✖ account/purpose is required" };
        }
        const res = await createJob(env, ctx, {
            type: "bank",
            userTag,
            userId,
            dedupeKey: interaction.id,
            opts: {
                type: "bank",
                name: v.account.slice(0, 60),
                account: v.account.slice(0, 100),
                amount: (v.amount || "").slice(0, 40),
                note: (v.note || "").slice(0, 1000)
            },
            fileName: null,
            fileBytes: null
        });
        return {
            embeds: [{
                title: "Ivorist Bank — request logged",
                color: 0x2f6b49,
                description:
                    `🏦 **Ivorist Bank is coming soon.** Your request was stored in the ops log and will be processed when the treasury launches.\n\n` +
                    `**account/purpose:** ${v.account.slice(0, 100)}${v.amount ? `\n**amount:** ${String(v.amount).slice(0, 40)}` : ""}${v.note ? `\n**details:** ${String(v.note).slice(0, 400)}` : ""}\n\n` +
                    `job id: \`${res.jobId}\` • find it any time with \`/log\``,
                footer: { text: "Ivorist Ops" }
            }]
        };
    }

    return { content: "⁉ unknown form" };
}

function optsMap(interaction) {
    const map = {};
    for (const option of (interaction.data.options || [])) {
        map[option.name] = option.value;
    }
    return map;
}

function attachmentFor(interaction) {
    const options = interaction.data.options || [];
    const attOpt = options.find((o) => o.type === 11);
    if (!attOpt) {
        return null;
    }
    const att = (interaction.data.resolved && interaction.data.resolved.attachments)
        ? interaction.data.resolved.attachments[attOpt.value]
        : null;
    return att || null;
}

function gate(env, interaction, channelVar) {
    if (env.GUILD_ID && interaction.guild_id && interaction.guild_id !== env.GUILD_ID) {
        return "this command only works inside the Ivorist server";
    }
    const channel = env[channelVar];
    if (channel && interaction.channel_id && interaction.channel_id !== channel) {
        return `this command belongs in <#${channel}>`;
    }
    return null;
}

function zipGate(env, att) {
    if (!att) {
        return "zip file is missing (add a `zip` attachment)";
    }
    if (!String(att.filename).toLowerCase().endsWith(".zip")) {
        return "attachment must be a .zip";
    }
    if ((att.size || 0) > LIMITS.maxZipBytes) {
        return `zip is ${(att.size / 1048576).toFixed(1)} MB; the cap is ${(LIMITS.maxZipBytes / 1048576).toFixed(0)} MB`;
    }
    return null;
}

async function command(interaction, env, ctx) {
    const name = interaction.data.name;
    const options = optsMap(interaction);

    if (name === "ping") {
        const aliveTs = await getRunnerAlive(env);
        const alive = aliveTs && (Date.now() - aliveTs < 600000);
        return {
            content: `🟢 gateway edge: online\n🟡 runner: ${alive ? "online (this PC reachable)" : "offline — jobs will queue here until the PC is back"}`
        };
    }

    if (name === "create") {
        const err = gate(env, interaction, "CHANNEL_APP");
        if (err) {
            return { content: `✖ ${err}` };
        }
        const slug = slugChecks(options.subdomain);
        if (!slug.ok) {
            return { content: `✖ ${slug.reason}` };
        }
        const att = attachmentFor(interaction);
        const zipErr = zipGate(env, att);
        if (zipErr) {
            return { content: `✖ ${zipErr}` };
        }
        const bytes = await fetch(att.url).then((r) => r.arrayBuffer());
        const res = await createJob(env, ctx, {
            type: "app",
            userTag: interaction.member?.user?.username || interaction.user?.username || "unknown",
            userId: interaction.member?.user?.id || interaction.user?.id,
            dedupeKey: interaction.id,
            opts: {
                subdomain: slug.subdomain,
                name: String(options.name || "").slice(0, 60) || slug.subdomain,
                description: String(options.description || "").slice(0, 400)
            },
            fileName: att.filename,
            fileBytes: bytes
        });
        return res.duplicate
            ? { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` }
            : { content: `🧾 job \`${res.jobId}\` queued for **${slug.subdomain}.ivorists.com** — follow the tracker in this channel` };
    }

    if (name === "project") {
        const err = gate(env, interaction, "CHANNEL_PROJECT");
        if (err) {
            return { content: `✖ ${err}` };
        }
        const att = attachmentFor(interaction);
        const zipErr = zipGate(env, att);
        if (zipErr) {
            return { content: `✖ ${zipErr}` };
        }
        if (!options.name || !options.summary) {
            return { content: "✖ `name` and `summary` are required" };
        }
        const bytes = await fetch(att.url).then((r) => r.arrayBuffer());
        const res = await createJob(env, ctx, {
            type: "project",
            userTag: interaction.member?.user?.username || interaction.user?.username || "unknown",
            userId: interaction.member?.user?.id || interaction.user?.id,
            dedupeKey: interaction.id,
            opts: {
                name: String(options.name).slice(0, 60),
                category: String(options.category || "Software").slice(0, 60),
                summary: String(options.summary).slice(0, 400),
                description: String(options.description || "").slice(0, 400)
            },
            fileName: att.filename,
            fileBytes: bytes
        });
        return res.duplicate
            ? { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` }
            : { content: `🧾 job \`${res.jobId}\` queued — **${options.name}** will land on the site` };
    }

    if (name === "change") {
        const err = gate(env, interaction, "CHANNEL_CHANGE");
        if (err) {
            return { content: `✖ ${err}` };
        }
        const att = attachmentFor(interaction);
        const zipErr = zipGate(env, att);
        if (zipErr) {
            return { content: `✖ ${zipErr}` };
        }
        if (!options.summary) {
            return { content: "✖ `summary` is required" };
        }
        const bytes = await fetch(att.url).then((r) => r.arrayBuffer());
        const res = await createJob(env, ctx, {
            type: "change",
            userTag: interaction.member?.user?.username || interaction.user?.username || "unknown",
            userId: interaction.member?.user?.id || interaction.user?.id,
            dedupeKey: interaction.id,
            opts: {
                name: String(options.summary).slice(0, 60),
                summary: String(options.summary).slice(0, 400)
            },
            fileName: att.filename,
            fileBytes: bytes
        });
        return res.duplicate
            ? { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` }
            : { content: `🧾 job \`${res.jobId}\` queued — change will be reviewed by the rules and deployed if it passes` };
    }

    if (name === "bank") {
        const err = gate(env, interaction, "CHANNEL_BANK");
        if (err) {
            return { content: `✖ ${err}` };
        }
        return {
            content: "🏦 **Ivorist Bank is coming soon.** No jobs accepted in this channel yet.",
            embeds: [{
                title: "Ivorist Bank",
                color: 0x2f6b49,
                description: "Reserved for the Ivorist treasury. Rules, checks and the pipeline for this channel ship in a later update.",
                footer: { text: "Ivorist Ops" }
            }]
        };
    }

    if (name === "apps") {
        const apps = await listApps(env);
        if (!apps.length) {
            return { content: "📭 the workbench is empty — no apps deployed yet." };
        }
        return {
            embeds: [{
                title: "Deployed web apps",
                color: 0x2f6b49,
                fields: apps.slice(-20).map((a) => ({
                    name: a.slug,
                    value: `<${a.url}> • branch \`${a.branch}\``,
                    inline: false
                }))
            }]
        };
    }

    if (name === "status") {
        let job = null;
        if (options.job_id) {
            job = await getJob(env, String(options.job_id).trim());
        } else {
            const jobs = await listJobs(env, 1);
            job = jobs[0] || null;
        }
        if (!job) {
            return { content: "ℹ no such job" };
        }
        return { embeds: [trackerEmbed(job)] };
    }

    if (name === "log") {
        const jobs = await listJobs(env, 10);
        if (!jobs.length) {
            return { content: "📭 no jobs yet." };
        }
        return {
            embeds: [{
                title: "Recent jobs",
                color: 0x2f6b49,
                fields: jobs.map((job) => ({
                    name: `${job.id} — ${job.title}`,
                    value: `${pipelineFor(job.type) ? job.type : "?"} • **${job.status}** • by ${job.userTag} • <t:${Math.floor(job.createdAt / 1000)}:R>`,
                    inline: false
                }))
            }]
        };
    }

    if (name === "clear" || name === "kill" || name === "cancel") {
        const targetId = options.job_id ? String(options.job_id).trim() : null;
        if (targetId) {
            const res = await killJob(env, targetId, `killed via /${name} by ${userTagOf(interaction)}`);
            if (!res.ok) {
                return { content: `✖ could not kill job \`${targetId}\`: ${res.error}` };
            }
            return { content: `🛑 **Job \`${targetId}\` was killed immediately.** Pipeline execution aborted.` };
        } else {
            if (name === "clear") {
                const clearRes = await clearAllJobs(env);
                return { content: `🧹 **Cleared ${clearRes.cleared} job(s) from state.** All queues and pending tasks wiped.` };
            }
            const jobs = await listJobs(env, 10);
            const activeJob = jobs.find((j) => j.status === "running" || j.status === "pending" || j.status === "awaiting");
            if (!activeJob) {
                return { content: "ℹ no active or pending jobs to kill." };
            }
            await killJob(env, activeJob.id, `killed via /${name} by ${userTagOf(interaction)}`);
            return { content: `🛑 **Active job \`${activeJob.id}\` (${activeJob.title}) killed immediately.** Pipeline execution aborted.` };
        }
    }

    return { content: `⁉ unknown command ${name}` };
}

/* =========================================================
   Runner daemon endpoints (Bearer RUNNER_TOKEN)
   ========================================================= */

async function runner(request, env, ctx) {
    const url = new URL(request.url);
    const route = url.pathname;

    if (request.method === "POST" && route === "/runner/claim") {
        if (env.GATEWAY_ENABLED === "1" && env.GATEWAY) {
            ctx.waitUntil((async () => {
                try {
                    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
                    await stub.fetch("https://do.internal/ensure");
                } catch { /* background keepalive */ }
            })());
        }
        const job = await popQueue(env);
        if (job) {
            ctx.waitUntil(ensureTracker(env, job).then((j) => patchTracker(env, j)));
        }
        return json({ job: job || null });
    }

    if (request.method === "GET" && route.startsWith("/runner/artifact/")) {
        const id = route.split("/").pop();
        const job = await getJob(env, id);
        if (!job) {
            return json({ error: "unknown job" }, 404);
        }
        const obj = await env.BLOBS.get(`zips/${job.id}/${job.fileName}`);
        if (!obj) {
            return json({ error: "artifact missing" }, 404);
        }
        return new Response(obj.body, {
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Filename": encodeURIComponent(job.fileName)
            }
        });
    }

    if (request.method === "POST" && route === "/runner/progress") {
        const p = await request.json();
        const res = await progress(env, ctx, p.jobId, p.step, p.state, p.detail);
        return json(res);
    }

    if (request.method === "POST" && route === "/runner/heartbeat") {
        await setRunnerAlive(env, Date.now());
        return json({ ok: true });
    }

    if (request.method === "POST" && route === "/runner/result") {
        const p = await request.json();
        const job = await getJob(env, p.jobId);
        if (!job) {
            return json({ error: "unknown job" }, 404);
        }
        job.status = p.status === "done" ? "done" : p.status === "rejected" ? "rejected" : "failed";
        job.urls = Array.isArray(p.urls) ? p.urls.slice(0, 5) : [];
        job.branch = p.branch || job.branch;
        job.error = p.error ? String(p.error).slice(0, LIMITS.maxErrorChars) : job.error;
        await finalizeJob(env, job);
        return json({ ok: true });
    }

    if (request.method === "POST" && (route === "/runner/enqueue-test" || route === "/runner/enqueue")) {
        const meta = JSON.parse(request.headers.get("X-Job") || request.headers.get("X-Test-Job") || "{}");
        const bytes = await request.arrayBuffer();
        if (!metadataValid(meta, bytes.byteLength)) {
            return json({ error: "invalid job metadata" }, 400);
        }
        if (meta.type === "app") {
            const slug = slugChecks(meta.subdomain);
            if (!slug.ok) {
                return json({ error: slug.reason }, 400);
            }
        }
        const res = await createJob(env, ctx, {
            type: meta.type,
            userTag: meta.userTag || "selftest",
            userId: meta.userId || "0",
            opts: meta,
            dedupeKey: null,
            fileName: bytes.byteLength ? (meta.fileName || "submission.zip") : null,
            fileBytes: bytes.byteLength ? bytes : null
        });
        return json(res);
    }

    // Attach files to a job that opened through a form and is waiting for them.
    if (request.method === "POST" && route === "/runner/attach") {
        const meta = JSON.parse(request.headers.get("X-Job") || "{}");
        const id = String(meta.jobId || "").trim();
        const job = await getJob(env, id);
        if (!job) {
            return json({ error: "unknown job" }, 404);
        }
        if (!["app", "project", "change"].includes(job.type)) {
            return json({ error: "this job type does not take files" }, 400);
        }
        if (!["awaiting", "pending"].includes(job.status)) {
            return json({ error: `job is ${job.status}, not awaiting files` }, 409);
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength === 0) {
            return json({ error: "empty attachment bundle" }, 400);
        }
        if (bytes.byteLength > LIMITS.maxZipBytes) {
            return json({ error: "attachment bundle over the size cap" }, 400);
        }
        job.fileName = String(meta.fileName || "attachments.zip");
        job.fileSize = bytes.byteLength;
        job.textOnly = false;
        await env.BLOBS.put(`zips/${job.id}/${job.fileName}`, bytes);
        const updated = await patchJob(env, job.id, {
            fileName: String(meta.fileName || "attachments.zip"),
            fileSize: bytes.byteLength,
            textOnly: false,
            status: "pending"
        });
        const currentJob = updated || { ...job, fileName: String(meta.fileName || "attachments.zip"), fileSize: bytes.byteLength, textOnly: false, status: "pending" };
        await patchTracker(env, currentJob);
        if (!currentJob.aiReview) {
            ctx.waitUntil(reviewJobWithAI(env, currentJob).catch(() => {}));
        }
        return json({ ok: true, jobId: job.id, status: currentJob.status });
    }

    if (request.method === "POST" && route === "/runner/test-ai") {
        const dummyJob = {
            id: "diag-" + Date.now().toString(36),
            type: "project",
            title: "NVIDIA Endpoint Connectivity Test",
            name: "NVIDIA Endpoint Connectivity Test",
            summary: "Verifying live endpoint response",
            userTag: "selftest",
            status: "pending",
            steps: {},
            createdAt: Date.now()
        };
        const start = Date.now();
        await reviewJobWithAI(env, dummyJob);
        const durationMs = Date.now() - start;
        return json({ ok: true, durationMs, aiReview: dummyJob.aiReview });
    }

    // Bind a Discord user to a job so their next attachment message completes it.
    if (request.method === "POST" && route === "/runner/bind") {
        const p = await request.json();
        if (!p.userId || !p.jobId) {
            return json({ error: "userId and jobId required" }, 400);
        }
        await bindUser(env, p.userId, p.jobId, p.type, p.ttlMinutes);
        return json({ ok: true });
    }

    if (request.method === "POST" && route === "/runner/unbind") {
        const p = await request.json();
        if (p.userId) {
            await unbindUser(env, p.userId);
        }
        return json({ ok: true });
    }

    if (request.method === "GET" && route.startsWith("/runner/bind/")) {
        const userId = decodeURIComponent(route.substring("/runner/bind/".length));
        const bind = await getBind(env, userId);
        return json(bind || null);
    }

    if (request.method === "GET" && route.startsWith("/runner/job/")) {
        const id = decodeURIComponent(route.split("/").pop());
        const job = await getJob(env, id);
        if (!job) {
            return json({ error: "unknown job" }, 404);
        }
        return json(job);
    }

    if (request.method === "GET" && route === "/runner/jobs") {
        return json(await listJobs(env, 20));
    }

    if (request.method === "POST" && route === "/runner/jobs/clear") {
        const res = await clearAllJobs(env);
        return json(res);
    }

    if (request.method === "POST" && route === "/runner/register-commands") {
        const appRes = await rest(env, "GET", "/oauth2/applications/@me");
        if (!appRes.ok || !appRes.data?.id) {
            return json({ error: "could not fetch application id from Discord", detail: appRes.error }, 500);
        }
        const appId = appRes.data.id;
        const guildId = env.GUILD_ID;
        const targetPath = guildId
            ? `/applications/${appId}/guilds/${guildId}/commands`
            : `/applications/${appId}/commands`;

        const commands = [
            { name: "create", description: "Open the deploy form — files are attached in the channel afterwards." },
            { name: "project", description: "Open the project form — text alone builds the project page." },
            { name: "change", description: "Open the site-change form — attach files in the channel afterwards." },
            { name: "bank", description: "Open the Ivorist Bank request form (logged until launch)." },
            { name: "apps", description: "List deployed web apps." },
            {
                name: "status",
                description: "Show the tracker embed for a job.",
                options: [{ type: 3, name: "job_id", description: "Job id, e.g. j-a1b2c3-xyz (blank = latest)", required: false }]
            },
            { name: "log", description: "Recent job log." },
            { name: "ping", description: "Check which parts of the toolchain are online." },
            {
                name: "clear",
                description: "Clear all pending/active jobs or kill a specific job.",
                options: [{ type: 3, name: "job_id", description: "Job id to kill immediately (blank = clear entire queue)", required: false }]
            },
            {
                name: "kill",
                description: "Kill a running/pending job immediately without letting it finish.",
                options: [{ type: 3, name: "job_id", description: "Job id to kill immediately (blank = current active job)", required: false }]
            }
        ];

        const regRes = await rest(env, "PUT", targetPath, commands);
        return json(regRes);
    }

    if (request.method === "POST" && route.startsWith("/runner/job/") && route.endsWith("/kill")) {
        const parts = route.split("/");
        const id = decodeURIComponent(parts[parts.length - 2]);
        const body = await request.json().catch(() => ({}));
        const res = await killJob(env, id, body.reason || "killed by runner request");
        return json(res, res.ok ? 200 : 404);
    }

    if (request.method === "GET" && route === "/runner/apps") {
        return json(await listApps(env));
    }

    if (request.method === "DELETE" && route.startsWith("/runner/apps/")) {
        const slug = decodeURIComponent(route.slice("/runner/apps/".length));
        return json(await forgetApp(env, slug));
    }

    return json({ error: "not found" }, 404);
}

function metadataValid(meta, size) {
    if (!["app", "project", "change", "bank"].includes(meta.type)) {
        return false;
    }
    if (size < 0 || size > LIMITS.maxZipBytes) {
        return false;
    }
    if (meta.type === "bank" && size > 0) {
        return false;
    }
    return true;
}
