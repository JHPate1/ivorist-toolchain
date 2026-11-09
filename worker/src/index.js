import nacl from "tweetnacl";

import {
    createJob,
    ensureTracker,
    finalizeJob,
    getJob,
    listApps,
    listJobs,
    patchTracker,
    popQueue,
    progress,
    requeueStale,
    trackerEmbed
} from "./jobs.js";
import { GatewayBot } from "./gateway.js";
import { LIMITS, slugChecks, pipelineFor } from "../../rules.js";

export { GatewayBot };

/* =========================================================
   HTTP surface
   ========================================================= */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
            const alive = await env.JOBS.get("runner:alive");
            return json({
                ok: true,
                discord: env.DISCORD_TOKEN && env.DISCORD_TOKEN !== "set-later" ? "ready" : "not configured",
                runner: alive ? "online" : "offline"
            });
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
            try {
                await env.GATEWAY.fetch("https://do.internal/ensure");
            } catch (error) {
                console.error("cron gateway ensure:", error);
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

    if (interaction.type !== 2) {
        return json({ type: 1 });
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
    if (env.GUILD_ID && interaction.guild_id !== env.GUILD_ID) {
        return "this command only works inside the Ivorist server";
    }
    const channel = env[channelVar];
    if (channel && interaction.channel_id !== channel) {
        return "wrong channel for this command";
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
        const alive = await env.JOBS.get("runner:alive");
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

    return { content: `⁉ unknown command ${name}` };
}

/* =========================================================
   Runner daemon endpoints (Bearer RUNNER_TOKEN)
   ========================================================= */

async function runner(request, env, ctx) {
    const url = new URL(request.url);
    const route = url.pathname;

    if (request.method === "POST" && route === "/runner/claim") {
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
        await env.JOBS.put("runner:alive", Date.now().toString(), { expirationTtl: 150 });
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
        const res = await createJob(env, ctx, {
            type: meta.type,
            userTag: meta.userTag || "selftest",
            userId: meta.userId || "0",
            opts: meta,
            dedupeKey: null,
            fileName: meta.fileName || "submission.zip",
            fileBytes: bytes
        });
        return json(res);
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

    if (request.method === "GET" && route === "/runner/apps") {
        return json(await listApps(env));
    }

    return json({ error: "not found" }, 404);
}

function metadataValid(meta, size) {
    if (!["app", "project", "change"].includes(meta.type)) {
        return false;
    }
    if (size === 0 || size > LIMITS.maxZipBytes) {
        return false;
    }
    if (size >= LIMITS.maxZipBytes) {
        return false;
    }
    return true;
}
