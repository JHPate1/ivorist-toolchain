import { pipelineFor } from "../../rules.js";

/* =========================================================
   Discord REST + job persistence + the live status embed
   All state lives in Durable Object storage (GatewayBot).
   KV has been completely removed to avoid quota exhaustion.
   ========================================================= */

const DISCORD_BASE = "https://discord.com/api/v10";

export const COLORS = {
    queued: 0xf59e0b,
    awaiting: 0xf59e0b,
    running: 0x2f6b49,
    done: 0x4ade80,
    failed: 0xb91c1c,
    rejected: 0xb91c1c,
    killed: 0xb91c1c,
    parked: 0x2f6b49
};

export const TYPE_LABELS = {
    app: "Web app deploy",
    project: "Site project",
    change: "Site change",
    bank: "Ivorist Bank"
};

export const CHANNEL_FOR_TYPE = {
    app: "CHANNEL_APP",
    project: "CHANNEL_PROJECT",
    change: "CHANNEL_CHANGE",
    bank: "CHANNEL_BANK"
};

export async function rest(env, method, path, body) {
    const token = env.DISCORD_TOKEN;
    if (!token || token === "set-later") {
        return { ok: false, status: 0, error: "discord token not configured" };
    }
    const init = {
        method,
        headers: {
            "Authorization": `Bot ${token}`
        }
    };
    if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(DISCORD_BASE + path, init);
    } catch (error) {
        return { ok: false, status: 0, error: String(error) };
    }
    if (res.status === 429) {
        let info = {};
        try {
            info = await res.json();
        } catch { /* ignore */ }
        const waitMs = Math.min(Math.ceil((info.retry_after || 1) * 1000), 5000);
        await new Promise((r) => setTimeout(r, waitMs));
        try {
            res = await fetch(DISCORD_BASE + path, init);
        } catch (error) {
            return { ok: false, status: 0, error: String(error) };
        }
    }
    let data = null;
    try {
        data = await res.json();
    } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : JSON.stringify(data).slice(0, 300) };
}

/* -------------------- DO communication -------------------- */

export async function doFetch(env, path, method = "GET", body = null) {
    // 1) Direct call if running inside GatewayBot or env._bot attached
    if (env && env._bot && typeof env._bot.handleInternalCall === "function") {
        return env._bot.handleInternalCall(path, method, body);
    }
    if (env && env.state?.storage && typeof env.handleInternalCall === "function") {
        return env.handleInternalCall(path, method, body);
    }
    // 2) Worker fetch via DO stub
    if (!env || !env.GATEWAY) {
        throw new Error("GATEWAY durable object not bound");
    }
    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
    const init = { method };
    if (body !== null && body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
    }
    const res = await stub.fetch("https://do.internal/do" + path, init);
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`DO error ${res.status}: ${txt}`);
    }
    return res.json();
}

/* -------------------- pipeline steps -------------------- */

export function newSteps(type) {
    const steps = {};
    for (const name of pipelineFor(type)) {
        steps[name] = { state: "pending", detail: "" };
    }
    return steps;
}

const STEP_ICONS = { pending: "○", active: "◐", done: "✔", failed: "✖" };

export function trackerEmbed(job) {
    const state = job.status;
    const lines = [];
    for (const name of pipelineFor(job.type)) {
        const step = (job.steps && job.steps[name]) || { state: "pending", detail: "" };
        lines.push(`${STEP_ICONS[step.state] || step.icon || "○"} ${name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    let fields = [
        {
            name: "STATUS",
            value: `**${String(state).toUpperCase()}**${state === "done" && (job.url || job.urls?.[0]) ? ` → <${job.url || job.urls[0]}>` : ""}`,
            inline: false
        },
        {
            name: "PIPELINE",
            value: lines.length ? lines.join("\n").slice(0, 1000) : "(no steps)",
            inline: false
        }
    ];
    if (job.aiReview) {
        fields.push({
            name: "AI REVIEW",
            value: job.aiReview.slice(0, 1024),
            inline: false
        });
    }
    if (job.error) {
        fields.push({
            name: state === "rejected" ? "REJECTION REASON" : "ERROR",
            value: job.error.slice(0, 1000),
            inline: false
        });
    }
    if (job.urls && job.urls.length) {
        fields.push({
            name: "LIVE",
            value: job.urls.map((u) => `<${u}>`).join("\n").slice(0, 800),
            inline: false
        });
    }
    if (job.type === "bank") {
        fields = [
            {
                name: "STATUS",
                value: `**${String(state).toUpperCase()}** — request received, the bank launches soon`,
                inline: false
            },
            {
                name: "REQUEST",
                value: [
                    job.account ? `account: ${job.account}` : "",
                    job.amount ? `amount: ${job.amount}` : "",
                    job.note || ""
                ].filter(Boolean).join("\n").slice(0, 1000) || "(no details)",
                inline: false
            }
        ];
        if (job.aiReview) {
            fields.push({
                name: "AI REVIEW",
                value: job.aiReview.slice(0, 1024),
                inline: false
            });
        }
    }
    return {
        title: `${job.status === "done" ? "🟢" : job.status === "failed" || job.status === "rejected" ? "🔴" : "🟡"} ${TYPE_LABELS[job.type] || job.type} — ${job.title}`,
        color: COLORS[state] || COLORS.queued,
        fields,
        footer: {
            text: `Ivorist Ops • job ${job.id} • by ${job.userTag}`
        },
        timestamp: new Date(job.updatedAt || job.createdAt).toISOString()
    };
}

/* -------------------- persistence in Durable Object -------------------- */

export async function putJob(env, job) {
    job.updatedAt = Date.now();
    await doFetch(env, "/job", "POST", { job });
    return job;
}

export async function patchJob(env, id, patch) {
    return doFetch(env, `/job?id=${encodeURIComponent(id)}`, "PATCH", { id, patch });
}

export async function getJob(env, id) {
    return doFetch(env, `/job?id=${encodeURIComponent(id)}`, "GET");
}

export async function listJobs(env, limit = 10) {
    return doFetch(env, `/jobs?limit=${Number(limit) || 10}`, "GET");
}

export async function clearAllJobs(env) {
    return doFetch(env, "/jobs/clear", "POST", {});
}

export async function killJob(env, id, reason = "killed by user request") {
    const job = await getJob(env, id);
    if (!job) {
        return { ok: false, error: "job not found" };
    }
    const patch = {
        status: "killed",
        error: reason,
        updatedAt: Date.now()
    };
    if (job.steps) {
        for (const [k, v] of Object.entries(job.steps)) {
            if (v.state === "active" || v.state === "pending") {
                job.steps[k] = { state: "failed", detail: "aborted/killed" };
            }
        }
        patch.steps = job.steps;
    }
    const updated = await patchJob(env, id, patch);
    const jobForTracker = updated || { ...job, ...patch };
    try {
        await ensureTracker(env, jobForTracker);
        await patchTracker(env, jobForTracker);
    } catch (e) {
        console.error("killJob tracker patch failed:", e);
    }
    return { ok: true, job: jobForTracker };
}

export async function pushQueue(env, jobId) {
    // Queue is no longer stored in KV.
    // In Durable Object storage, pending jobs are claimed directly by status.
    return Promise.resolve();
}

export async function popQueue(env) {
    const res = await doFetch(env, "/claim", "POST");
    return res?.job || null;
}

export async function requeueStale(env) {
    const res = await doFetch(env, "/requeue-stale", "POST");
    const changed = res?.changed || [];
    for (const job of changed) {
        await patchTracker(env, job);
    }
    return changed;
}

export async function getRunnerAlive(env) {
    const res = await doFetch(env, "/runner-alive", "GET");
    return res?.alive || 0;
}

export async function setRunnerAlive(env, timestamp = Date.now()) {
    return doFetch(env, "/runner-alive", "POST", { timestamp });
}

export async function bindUser(env, userId, jobId, type, ttlMinutes = 30) {
    const ttl = Math.min(Math.max(Number(ttlMinutes) || 30, 1), 90) * 60;
    const bind = {
        jobId,
        type: type || "",
        expiry: Date.now() + ttl * 1000
    };
    return doFetch(env, "/bind", "POST", { userId, bind });
}

export async function unbindUser(env, userId) {
    return doFetch(env, `/bind?userId=${encodeURIComponent(userId)}`, "DELETE");
}

export async function getBind(env, userId) {
    return doFetch(env, `/bind?userId=${encodeURIComponent(userId)}`, "GET");
}

export async function listApps(env) {
    return doFetch(env, "/apps", "GET");
}

export async function rememberApp(env, job) {
    const entry = {
        slug: job.subdomain,
        url: job.urls[0],
        branch: job.branch,
        jobId: job.id,
        createdAt: job.createdAt
    };
    return doFetch(env, "/apps", "POST", { entry });
}

/* -------------------- embed live updates -------------------- */

export async function ensureTracker(env, job) {
    if (job.messageId) {
        return job;
    }
    const current = await getJob(env, job.id);
    if (current?.messageId) {
        job.messageId = current.messageId;
        return current;
    }
    const channel = env[CHANNEL_FOR_TYPE[job.type]];
    if (!channel) {
        return job;
    }
    try {
        const latestForEmbed = current || job;
        const res = await rest(env, "POST", `/channels/${channel}/messages`, { embeds: [trackerEmbed(latestForEmbed)] });
        if (res.ok && res.data && res.data.id) {
            job.messageId = res.data.id;
            await patchJob(env, job.id, { messageId: res.data.id });
        }
    } catch (error) {
        console.error("ensureTracker:", String(error).slice(0, 200));
    }
    return job;
}

export async function patchTracker(env, job) {
    if (!job.messageId) {
        return;
    }
    const channel = env[CHANNEL_FOR_TYPE[job.type]];
    if (!channel) {
        return;
    }
    try {
        await rest(env, "PATCH", `/channels/${channel}/messages/${job.messageId}`, {
            embeds: [trackerEmbed(job)]
        });
    } catch (error) {
        console.error("patchTracker:", String(error).slice(0, 200));
    }
}

/* -------------------- NVIDIA AI Review -------------------- */

function formatJobForAI(job) {
    return [
        `Job ID: ${job.id}`,
        `Type: ${job.type}`,
        `Title: ${job.title || job.name || "Untitled"}`,
        job.subdomain ? `Subdomain: ${job.subdomain}` : "",
        job.summary ? `Summary: ${job.summary}` : "",
        job.description ? `Description: ${job.description}` : "",
        job.category ? `Category: ${job.category}` : "",
        job.technologies ? `Technologies: ${job.technologies}` : "",
        job.envText ? `Env vars: ${job.envText.slice(0, 500)}` : "",
        job.account ? `Account: ${job.account}` : "",
        job.amount ? `Amount: ${job.amount}` : "",
        job.note ? `Note: ${job.note}` : "",
        job.fileName ? `File: ${job.fileName} (${job.fileSize} bytes)` : "No file attached",
        `Submitted by: ${job.userTag}`
    ].filter(Boolean).join("\n");
}

export async function reviewJobWithAI(env, job) {
    const apiKey = env.NVIDIA_API_KEY;
    if (!apiKey) {
        console.warn("NVIDIA_API_KEY is not set, skipping AI review");
        return;
    }
    const prompt = formatJobForAI(job);
    let reviewText = null;
    try {
        const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            signal: AbortSignal.timeout(90000),
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                model: "z-ai/glm-5.3-flash",
                messages: [
                    {
                        role: "system",
                        content: "You are an automated ops code engineer for Ivorist. Provide your technical assessment and list any actions or questions directly in 2-3 sentences. Never ask for user confirmation or wait. Output immediately."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.3,
                top_p: 1,
                max_tokens: 300,
                stream: false
            })
        });

        let data = null;
        let rawText = "";
        if (typeof res.text === "function") {
            rawText = await res.text();
            try {
                data = JSON.parse(rawText);
            } catch {
                /* non-json */
            }
        } else if (typeof res.json === "function") {
            data = await res.json();
            rawText = JSON.stringify(data);
        }

        if (res.ok && data) {
            const content = data.choices?.[0]?.message?.content?.trim();
            if (content) {
                reviewText = content;
            } else {
                reviewText = "AI review completed with empty response";
            }
        } else {
            console.error(`NVIDIA API error: HTTP ${res.status} ${rawText.slice(0, 200)}`);
            reviewText = `AI review unavailable (HTTP ${res.status})`;
        }
    } catch (err) {
        console.error("NVIDIA API call failed:", err);
        reviewText = `AI review failed: ${String(err.message || err).slice(0, 200)}`;
    }

    job.aiReview = reviewText;
    try {
        const patched = await patchJob(env, job.id, { aiReview: reviewText });
        let trackerJob = patched || job;
        if (!trackerJob.messageId) {
            await new Promise((r) => setTimeout(r, 1200));
            const refreshed = await getJob(env, job.id);
            if (refreshed?.messageId) {
                trackerJob = refreshed;
            }
        }
        if (trackerJob.messageId) {
            await patchTracker(env, trackerJob);
        }
    } catch (e) {
        console.error("Failed to persist AI review:", e);
    }
}

/* -------------------- job creation -------------------- */

function randomId() {
    const hex = "0123456789abcdef";
    let out = "j-";
    for (let i = 0; i < 6; i += 1) {
        out += hex[Math.floor(Math.random() * 16)];
    }
    return out + "-" + Date.now().toString(36);
}

export async function createJob(env, ctx, request) {
    const { type, userTag, userId, opts, fileName, fileBytes } = request;
    const id = randomId();

    // Duplicate-interaction guard via Durable Object storage
    if (request.dedupeKey) {
        const marker = await doFetch(env, `/dedupe?key=${encodeURIComponent(request.dedupeKey)}`, "GET");
        if (marker?.jobId) {
            return { duplicate: true, jobId: marker.jobId };
        }
    }

    // Bank jobs are parked for treasury; all other jobs (whether with files or text-only)
    // are queued immediately into the pipeline so file attachment is never required.
    let status = "pending";
    if (type === "bank") {
        status = "parked";
    }

    const job = {
        id,
        type,
        status,
        createdAt: Date.now(),
        userTag,
        userId,
        title: opts.name || fileName || id,
        name: opts.name,
        description: opts.description,
        summary: opts.summary,
        category: opts.category,
        subdomain: opts.subdomain,
        textOnly: opts.textOnly === true,
        highlights: opts.highlights,
        technologies: opts.technologies,
        envText: opts.envText,
        account: opts.account,
        amount: opts.amount,
        note: opts.note,
        fileName,
        fileSize: fileBytes ? fileBytes.byteLength : 0,
        steps: newSteps(type),
        attempts: 0,
        urls: [],
        aiReview: null
    };

    if (request.dedupeKey) {
        await doFetch(env, "/dedupe", "POST", { key: request.dedupeKey, jobId: id, ttlSeconds: 600 });
    }

    // Persist artifact in R2
    if (fileBytes && fileName) {
        await env.BLOBS.put(`zips/${id}/${fileName}`, fileBytes);
    }
    await putJob(env, job);

    const runEnsure = ensureTracker(env, job).catch((e) => console.error("ensureTracker err:", e));
    const runReview = reviewJobWithAI(env, job).catch((e) => console.error("reviewJobWithAI err:", e));

    if (ctx && ctx.waitUntil) {
        ctx.waitUntil(runEnsure);
        ctx.waitUntil(runReview);
    }

    return { duplicate: false, jobId: id };
}

export async function progress(env, ctx, jobId, stepName, state, detail) {
    const job = await getJob(env, jobId);
    if (!job) {
        return { ok: false, error: "unknown job" };
    }
    if (job.status === "killed" || job.status === "cancelled") {
        return { ok: false, killed: true, error: "job killed by user" };
    }
    const patch = {};
    if (stepName && job.steps && job.steps[stepName]) {
        job.steps[stepName].state = state || "active";
        job.steps[stepName].detail = String(detail || "").slice(0, 200);
        patch.steps = job.steps;
    } else if (stepName === "__note") {
        job.note = String(detail || "").slice(0, 200);
        patch.note = job.note;
    }
    const updated = await patchJob(env, jobId, patch);
    const jobForTracker = updated || job;
    if (ctx && ctx.waitUntil) {
        ctx.waitUntil(ensureTracker(env, jobForTracker).then((j) => patchTracker(env, j)));
    } else {
        ensureTracker(env, jobForTracker).then((j) => patchTracker(env, j)).catch(() => {});
    }
    return { ok: true };
}

export async function finalizeJob(env, job) {
    const updated = await patchJob(env, job.id, {
        status: job.status,
        urls: job.urls,
        branch: job.branch,
        error: job.error
    });
    const jobForTracker = updated || job;
    await ensureTracker(env, jobForTracker).then((j) => patchTracker(env, j));
    if (jobForTracker.status === "done") {
        if (jobForTracker.type === "app") {
            await rememberApp(env, jobForTracker);
        }
    }
}
