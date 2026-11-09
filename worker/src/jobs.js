import { pipelineFor } from "../../rules.js";

/* =========================================================
   Discord REST + job persistence + the live status embed
   ========================================================= */

const DISCORD_BASE = "https://discord.com/api/v10";

export const COLORS = {
    queued: 0xf59e0b,
    awaiting: 0xf59e0b,
    running: 0x2f6b49,
    done: 0x4ade80,
    failed: 0xb91c1c,
    rejected: 0xb91c1c,
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
        // Retry at most once, respecting Discord's retry_after.
        let info = {};
        try {
            info = await res.json();
        } catch { /* ignore */ }
        const waitMs = Math.min(Math.ceil((info.retry_after || 1) * 1000), 5000);
        busyWait(waitMs);
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

function busyWait(ms) {
    const end = Date.now() + ms;
    let x = 0;
    while (Date.now() < end) {
        x += Math.sqrt(Math.sin(x) + 1.5);
    }
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
        const step = job.steps[name] || { state: "pending", detail: "" };
        lines.push(`${STEP_ICONS[step.state] || step.icon} ${name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    let fields = [
        {
            name: "STATUS",
            value: `**${String(state).toUpperCase()}**${state === "done" && job.url ? ` → <${job.url}>` : ""}`,
            inline: false
        },
        {
            name: "PIPELINE",
            value: lines.length ? lines.join("\n").slice(0, 1000) : "(no steps)",
            inline: false
        }
    ];
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
        // Bank jobs never run a pipeline: they are logged for the treasury.
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

/* -------------------- persistence -------------------- */

export async function putJob(env, job) {
    job.updatedAt = Date.now();
    await env.JOBS.put(`job:${job.id}`, JSON.stringify(job));
    return job;
}

export async function getJob(env, id) {
    const raw = await env.JOBS.get(`job:${id}`);
    return raw ? JSON.parse(raw) : null;
}

export async function listJobs(env, limit = 10) {
    const out = [];
    let cursor;
    do {
        const page = await env.JOBS.list({ prefix: "job:", cursor });
        for (const key of page.keys) {
            const raw = await env.JOBS.get(key.name);
            if (raw) {
                out.push(JSON.parse(raw));
            }
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && out.length < 40);
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, limit);
}

export async function pushQueue(env, jobId) {
    const raw = await env.JOBS.get("idx:pending") || "[]";
    const items = JSON.parse(raw);
    if (!items.includes(jobId)) {
        items.push(jobId);
    }
    await env.JOBS.put("idx:pending", JSON.stringify(items));
}

export async function popQueue(env) {
    const raw = await env.JOBS.get("idx:pending");
    const items = raw ? JSON.parse(raw) : [];
    while (items.length) {
        const id = items.shift();
        const job = await getJob(env, id);
        if (job && job.status === "pending") {
            await env.JOBS.put("idx:pending", JSON.stringify(items));
            return resultAs(claimAsRunning(job));
        }
    }
    await env.JOBS.put("idx:pending", "[]");
    return null;
}

function claimAsRunning(job) {
    job.status = "running";
    job.claimedAt = Date.now();
    return job;
}

function resultAs(job) {
    return job;
}

export async function requeueStale(env) {
    let cursor;
    do {
        const page = await env.JOBS.list({ prefix: "job:", cursor });
        for (const key of page.keys) {
            const raw = await env.JOBS.get(key.name);
            if (!raw) {
                continue;
            }
            const job = JSON.parse(raw);
            const leaseMs = Date.now() - (job.claimedAt || 0);
            if (job.status === "running" && leaseMs > 20 * 60 * 1000) {
                if ((job.attempts || 0) >= 2) {
                    job.status = "failed";
                    job.error = "runner never reported back after 2 attempts (this machine stayed offline)";
                    await finalizeJob(env, job);
                } else {
                    job.status = "pending";
                    job.attempts = (job.attempts || 0) + 1;
                    await putJob(env, job);
                    await pushQueue(env, job.id);
                    await patchTracker(env, job);
                }
            } else if (job.status === "awaiting" && Date.now() - job.createdAt > 30 * 60 * 1000) {
                job.status = "failed";
                job.error = "no files were attached within 30 minutes — form submission expired";
                await finalizeJob(env, job);
            }
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
}

/* -------------------- embed live updates -------------------- */

export async function ensureTracker(env, job) {
    if (job.messageId) {
        return job;
    }
    const channel = env[CHANNEL_FOR_TYPE[job.type]];
    if (!channel) {
        return job;
    }
    try {
        const res = await rest(env, "POST", `/channels/${channel}/messages`, { embeds: [trackerEmbed(job)] });
        if (res.ok && res.data && res.data.id) {
            job.messageId = res.data.id;
            await putJob(env, job);
        }
    } catch (error) {
        // Embed delivery must never take a job down; the runner's next
        // progress event retries the tracker automatically.
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

    // Duplicate-interaction guard.
    if (request.dedupeKey) {
        const marker = await env.JOBS.get(`dedupe:${request.dedupeKey}`);
        if (marker) {
            return { duplicate: true, jobId: marker };
        }
    }

    // Forms may submit text-only projects and bank requests with no files.
    // App/change jobs without an artifact wait for attachments to be bound.
    let status = "pending";
    if (type === "bank") {
        status = "parked";
    } else if (!fileBytes || fileBytes.byteLength === 0) {
        status = type === "project" ? "pending" : "awaiting";
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
        urls: []
    };

    if (request.dedupeKey) {
        await env.JOBS.put(`dedupe:${request.dedupeKey}`, id, { expirationTtl: 600 });
    }

    // Persist the artifact first so a crashed worker run loses nothing.
    if (fileBytes && fileName) {
        await env.BLOBS.put(`zips/${id}/${fileName}`, fileBytes);
    }
    await putJob(env, job);
    if (job.status === "pending") {
        await pushQueue(env, job.id);
    }

    // Fire-and-forget: bot may not be in the guild yet; ensureTracker retries
    // lazily when the runner reports its first progress event.
    ctx.waitUntil(ensureTracker(env, job));

    return { duplicate: false, jobId: id };
}

export async function progress(env, ctx, jobId, stepName, state, detail) {
    const job = await getJob(env, jobId);
    if (!job) {
        return { ok: false, error: "unknown job" };
    }
    if (stepName && job.steps[stepName]) {
        job.steps[stepName].state = state || "active";
        job.steps[stepName].detail = String(detail || "").slice(0, 200);
    } else if (stepName === "__note") {
        job.note = String(detail || "").slice(0, 200);
    }
    await putJob(env, job);
    ctx.waitUntil(ensureTracker(env, job).then((j) => patchTracker(env, j)));
    return { ok: true };
}

export async function finalizeJob(env, job) {
    await putJob(env, job);
    await ensureTracker(env, job).then((j) => patchTracker(env, j));
    if (job.status === "done") {
        if (job.type === "app") {
            await rememberApp(env, job);
        }
    }
}

async function rememberApp(env, job) {
    const raw = await env.JOBS.get("apps");
    const apps = raw ? JSON.parse(raw) : [];
    const entry = {
        slug: job.subdomain,
        url: job.urls[0],
        branch: job.branch,
        jobId: job.id,
        createdAt: job.createdAt
    };
    const existing = apps.findIndex((a) => a.slug === job.subdomain);
    if (existing >= 0) {
        apps[existing] = entry;
    } else {
        apps.push(entry);
    }
    await env.JOBS.put("apps", JSON.stringify(apps.slice(-100)));
}

export async function listApps(env) {
    const raw = await env.JOBS.get("apps");
    return raw ? JSON.parse(raw) : [];
}
