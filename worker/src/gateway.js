import {
    createJob,
    getJob,
    listJobs,
    patchJob,
    patchTracker,
    putJob,
    rest,
    reviewJobWithAI,
    trackerEmbed,
    killJob
} from "./jobs.js";
import { slugChecks, LIMITS } from "../../rules.js";
import { createZipStore } from "./zipstore.js";

/* =========================================================
   GatewayBot: a Durable Object that holds the Discord
   gateway WebSocket and the persistent SQLite storage.
   The bot runs entirely on Cloudflare:

   - 24/7 session (identify/heartbeat/resume per the gateway
     rules, including the ~5s IDENTIFY cadence)
   - slash commands open FORMS (modals): create/project/change/bank
   - forms enqueue artifact-less jobs; users then reply with
     files in the channel and this object binds them (any file
     type, multiple files, wrapped into a safe store zip)
   - text-only projects generate pages in the runner
   - bank requests are parked and logged
   - ad-hoc zip drops keep working
   - all state (jobs, binds, dedupe, apps, runner status) is
     stored in DO storage, eliminating Cloudflare KV put limits.
   ========================================================= */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 | (1 << 9); // GUILDS + GUILD_MESSAGES (not privileged)

const IDENTIFY_MIN_GAP = 5500;     // Discord: do not IDENTIFY more often than ~5s
const TYPE_LABELS = {
    app: "Web app deploy",
    project: "Site project",
    change: "Site change",
    bank: "Ivorist Bank"
};

function validToken(env) {
    return env.DISCORD_TOKEN && env.DISCORD_TOKEN !== "set-later";
}

/* ---------------------- forms ---------------------- */

export const MODALS = {
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

export function openModal(command) {
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

export function modalValues(interaction) {
    const map = {};
    for (const row of interaction.data?.components || []) {
        for (const field of row.components || []) {
            map[field.custom_id] = String(field.value ?? "").trim();
        }
    }
    return map;
}

export class GatewayBot {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        if (env) {
            env._bot = this;
        }
        this.ws = null;
        this.seq = null;
        this.sessionId = null;
        this.resumeUrl = null;
        this.heartbeatTimer = null;
        this.heartbeatAcked = true;
        this.backoffMs = 2000;
        this.started = false;
    }

    /* -------- Durable Object SQLite storage methods -------- */

    async putJob(job) {
        if (!job || !job.id) return null;
        job.updatedAt = Date.now();
        await this.state.storage.put(`job:${job.id}`, job);
        return job;
    }

    async patchJob(id, patch) {
        if (!id || !patch) return null;
        const job = await this.getJob(id);
        if (!job) return null;
        for (const [k, v] of Object.entries(patch)) {
            if (v !== undefined) {
                job[k] = v;
            }
        }
        job.updatedAt = Date.now();
        await this.state.storage.put(`job:${job.id}`, job);
        return job;
    }

    async getJob(id) {
        if (!id) return null;
        const job = await this.state.storage.get(`job:${id}`);
        return job ? (typeof job === "string" ? JSON.parse(job) : job) : null;
    }

    async listJobs(limit = 10) {
        const map = await this.state.storage.list({ prefix: "job:", limit: 1000 });
        const jobs = [];
        for (const val of map.values()) {
            if (val) {
                jobs.push(typeof val === "string" ? JSON.parse(val) : val);
            }
        }
        jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return jobs.slice(0, limit);
    }

    async clearAllJobs() {
        const map = await this.state.storage.list({ prefix: "job:", limit: 1000 });
        let count = 0;
        for (const key of map.keys()) {
            await this.state.storage.delete(key);
            count++;
        }
        // Also clear any dangling binds and dedupe records
        const binds = await this.state.storage.list({ prefix: "bind:", limit: 1000 });
        for (const key of binds.keys()) {
            await this.state.storage.delete(key);
        }
        const dedupes = await this.state.storage.list({ prefix: "dedupe:", limit: 1000 });
        for (const key of dedupes.keys()) {
            await this.state.storage.delete(key);
        }
        return { ok: true, cleared: count };
    }

    async claimJob() {
        const map = await this.state.storage.list({ prefix: "job:", limit: 1000 });
        const pending = [];
        for (const val of map.values()) {
            const job = typeof val === "string" ? JSON.parse(val) : val;
            if (job && job.status === "pending") {
                pending.push(job);
            }
        }
        if (pending.length === 0) {
            // DO NOT write anything on empty poll!
            return null;
        }
        // Oldest pending job first (FIFO)
        pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const job = pending[0];
        job.status = "running";
        job.claimedAt = Date.now();
        job.updatedAt = Date.now();
        await this.state.storage.put(`job:${job.id}`, job);
        return job;
    }

    async requeueStale() {
        const map = await this.state.storage.list({ prefix: "job:", limit: 1000 });
        const changed = [];
        for (const val of map.values()) {
            const job = typeof val === "string" ? JSON.parse(val) : val;
            if (!job) continue;
            const leaseMs = Date.now() - (job.claimedAt || 0);
            if (job.status === "running" && leaseMs > 20 * 60 * 1000) {
                if ((job.attempts || 0) >= 2) {
                    job.status = "failed";
                    job.error = "runner never reported back after 2 attempts (this machine stayed offline)";
                } else {
                    job.status = "pending";
                    job.attempts = (job.attempts || 0) + 1;
                }
                job.updatedAt = Date.now();
                await this.state.storage.put(`job:${job.id}`, job);
                changed.push(job);
            } else if (job.status === "awaiting" && Date.now() - (job.createdAt || 0) > 30 * 60 * 1000) {
                job.status = "failed";
                job.error = "no files were attached within 30 minutes — form submission expired";
                job.updatedAt = Date.now();
                await this.state.storage.put(`job:${job.id}`, job);
                changed.push(job);
            }
        }
        return changed;
    }

    async getRunnerAlive() {
        const val = await this.state.storage.get("runner:alive");
        return Number(val) || 0;
    }

    async setRunnerAlive(ts = Date.now()) {
        await this.state.storage.put("runner:alive", ts);
        return ts;
    }

    async getBind(userId) {
        if (!userId) return null;
        const raw = await this.state.storage.get(`bind:${userId}`);
        if (!raw) return null;
        const bind = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (bind.expiry && bind.expiry < Date.now()) {
            await this.state.storage.delete(`bind:${userId}`);
            return null;
        }
        return bind;
    }

    async putBind(userId, bind) {
        await this.state.storage.put(`bind:${userId}`, bind);
    }

    async deleteBind(userId) {
        await this.state.storage.delete(`bind:${userId}`);
    }

    async getDedupe(key) {
        if (!key) return null;
        const raw = await this.state.storage.get(`dedupe:${key}`);
        if (!raw) return null;
        const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (typeof entry === "object" && entry.expiry && entry.expiry < Date.now()) {
            await this.state.storage.delete(`dedupe:${key}`);
            return null;
        }
        return typeof entry === "object" ? entry.jobId : entry;
    }

    async putDedupe(key, jobId, ttlSeconds = 600) {
        const entry = { jobId, expiry: Date.now() + ttlSeconds * 1000 };
        await this.state.storage.put(`dedupe:${key}`, entry);
    }

    async getApps() {
        const raw = await this.state.storage.get("apps");
        if (!raw) return [];
        return typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    }

    async putApp(entry) {
        const apps = await this.getApps();
        const existing = apps.findIndex((a) => a.slug === entry.slug);
        if (existing >= 0) {
            apps[existing] = entry;
        } else {
            apps.push(entry);
        }
        const updated = apps.slice(-100);
        await this.state.storage.put("apps", updated);
        return updated;
    }

    async getGuidance(channelId) {
        const raw = await this.state.storage.get(`guidance:${channelId}`);
        if (!raw) return false;
        const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (entry.expiry && entry.expiry < Date.now()) {
            await this.state.storage.delete(`guidance:${channelId}`);
            return false;
        }
        return true;
    }

    async putGuidance(channelId, ttlSeconds = 120) {
        const entry = { expiry: Date.now() + ttlSeconds * 1000 };
        await this.state.storage.put(`guidance:${channelId}`, entry);
    }

    async handleInternalCall(pathAndQuery, method = "GET", body = null) {
        const dummyUrl = new URL(pathAndQuery, "https://do.internal");
        const pathname = dummyUrl.pathname;
        const searchParams = dummyUrl.searchParams;

        if (pathname === "/job" && method === "GET") {
            const id = searchParams.get("id");
            return this.getJob(id);
        }
        if (pathname === "/job" && method === "POST") {
            return this.putJob(body?.job);
        }
        if (pathname === "/job" && method === "PATCH") {
            const id = searchParams.get("id") || body?.id;
            return this.patchJob(id, body?.patch || body);
        }
        if (pathname === "/jobs" && method === "GET") {
            const limit = Number(searchParams.get("limit")) || 10;
            return this.listJobs(limit);
        }
        if (pathname === "/jobs/clear" && method === "POST") {
            return this.clearAllJobs();
        }
        if (pathname === "/job/kill" && method === "POST") {
            const id = searchParams.get("id") || body?.id;
            const reason = body?.reason || "killed by user request";
            const job = await this.getJob(id);
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
            const updated = await this.patchJob(id, patch);
            const jobForTracker = updated || { ...job, ...patch };
            try {
                await ensureTracker(this.env, jobForTracker);
                await patchTracker(this.env, jobForTracker);
            } catch (e) {
                console.error("killJob tracker patch failed:", e);
            }
            return { ok: true, job: jobForTracker };
        }
        if (pathname === "/claim" && method === "POST") {
            const job = await this.claimJob();
            return { job };
        }
        if (pathname === "/requeue-stale" && method === "POST") {
            const changed = await this.requeueStale();
            return { changed };
        }
        if (pathname === "/runner-alive" && method === "GET") {
            const alive = await this.getRunnerAlive();
            return { alive };
        }
        if (pathname === "/runner-alive" && method === "POST") {
            const ts = Number(body?.timestamp) || Date.now();
            await this.setRunnerAlive(ts);
            return { ok: true };
        }
        if (pathname === "/bind" && method === "GET") {
            const userId = searchParams.get("userId");
            return this.getBind(userId);
        }
        if (pathname === "/bind" && method === "POST") {
            await this.putBind(body.userId, body.bind);
            return { ok: true };
        }
        if (pathname === "/bind" && method === "DELETE") {
            const userId = searchParams.get("userId");
            await this.deleteBind(userId);
            return { ok: true };
        }
        if (pathname === "/dedupe" && method === "GET") {
            const key = searchParams.get("key");
            const jobId = await this.getDedupe(key);
            return { jobId };
        }
        if (pathname === "/dedupe" && method === "POST") {
            await this.putDedupe(body.key, body.jobId, body.ttlSeconds);
            return { ok: true };
        }
        if (pathname === "/apps" && method === "GET") {
            return this.getApps();
        }
        if (pathname === "/apps" && method === "POST") {
            return this.putApp(body.entry);
        }
        if (pathname === "/guidance" && method === "GET") {
            const channelId = searchParams.get("channelId");
            const active = await this.getGuidance(channelId);
            return { active };
        }
        if (pathname === "/guidance" && method === "POST") {
            await this.putGuidance(body.channelId, body.ttlSeconds);
            return { ok: true };
        }

        throw new Error(`unknown internal DO route: ${method} ${pathname}`);
    }

    /* -------- remote control (called by the worker) -------- */

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/do/")) {
            const pathAndQuery = url.pathname.slice(3) + url.search;
            let body = null;
            if (request.method !== "GET" && request.method !== "HEAD") {
                body = await request.json().catch(() => null);
            }
            try {
                const result = await this.handleInternalCall(pathAndQuery, request.method, body);
                return new Response(JSON.stringify(result ?? null), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message || String(err) }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        if (url.pathname === "/status") {
            const session = await this.state.storage.get("session-id");
            return new Response(JSON.stringify({
                active: Boolean(this.ws && this.ws.readyState === 1),
                sessionId: session || null,
                started: this.started
            }), {
                headers: { "Content-Type": "application/json" }
            });
        }
        if (url.pathname === "/start" || url.pathname === "/ensure") {
            await this.ensure();
            const session = await this.state.storage.get("session-id");
            return new Response(JSON.stringify({
                active: Boolean(this.ws && this.ws.readyState === 1),
                sessionId: session || null,
                started: this.started
            }), {
                headers: { "Content-Type": "application/json" }
            });
        }
        return new Response("nope", { status: 404 });
    }

    async alarm() {
        await this.ensure(true);
    }

    async ensure(force = false) {
        if (this.ws && this.ws.readyState === 1) {
            return;
        }
        if (!validToken(this.env)) {
            console.log("gateway ensure: DISCORD_TOKEN not usable");
            return;
        }
        if (this.env.GATEWAY_ENABLED === "0") {
            console.log("gateway ensure: GATEWAY_ENABLED=0");
            return;
        }
        if (this.started && !force) {
            return;
        }
        this.started = true;
        console.log(`gateway ensure: connecting (force=${force})`);
        await this.connect();
    }

    async connect() {
        let resumeUrl = GATEWAY_URL;
        const storedResumeRaw = await this.state.storage.get("resume-url");
        // Discard malformed URLs saved by an earlier build (e.g. "wss://wss://...").
        const storedResume = /^wss:\/\/(?!wss?:\/\/)[^/]+\//i.test(String(storedResumeRaw || "")) ? storedResumeRaw : null;
        if (storedResumeRaw && !storedResume) {
            await this.state.storage.delete("resume-url");
            await this.state.storage.delete("session-id");
            await this.state.storage.delete("seq");
        }
        const sessionId = await this.state.storage.get("session-id");
        const seq = await this.state.storage.get("seq");
        if (sessionId && seq != null) {
            resumeUrl = `${storedResume || GATEWAY_URL}&session_id=${sessionId}&seq=${seq}`;
        }

        const fetchUrl = resumeUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

        let wsResponse;
        try {
            wsResponse = await fetch(fetchUrl, { headers: { Upgrade: "websocket" } });
        } catch (error) {
            console.error("gateway connect failed:", String(error).slice(0, 200), fetchUrl);
            this.started = false;
            await this.scheduleReconnect();
            return;
        }
        const ws = wsResponse.webSocket;
        if (!ws) {
            console.error(`gateway connect: no websocket in response (status ${wsResponse.status})`);
            this.started = false;
            await this.scheduleReconnect();
            return;
        }
        ws.accept();
        this.ws = ws;
        this.started = true;
        this.heartbeatAcked = true;

        ws.addEventListener("message", (event) => {
            let frame;
            try {
                frame = JSON.parse(String(event.data));
            } catch {
                return;
            }
            try {
                this.handleFrame(frame);
            } catch (error) {
                console.error("gateway handleFrame:", String(error).slice(0, 160));
            }
        });

        ws.addEventListener("close", (event) => {
            try {
                this.handleClose(event && event.code, event && event.reason);
            } catch { /* */ }
        });

        ws.addEventListener("error", () => { /* close handler reconnects */ });
    }

    async scheduleReconnect() {
        const hasSession = Boolean(await this.state.storage.get("session-id"));
        let delay;
        if (hasSession) {
            delay = this.backoffMs;
        } else {
            const last = (await this.state.storage.get("last-identify-at")) || 0;
            const gap = IDENTIFY_MIN_GAP - (Date.now() - last);
            delay = Math.max(this.backoffMs, gap) + Math.random() * 1500;
        }
        if (delay < 1200) {
            delay = 1200;
        }
        this.backoffMs = Math.min(this.backoffMs * 2, 60000);
        try {
            await this.state.storage.setAlarm(Date.now() + delay);
        } catch {
            // alarm unavailable
        }
        setTimeout(() => {
            this.ensure(true).catch(() => {});
        }, delay);
    }

    async handleClose(code, reason) {
        const reasonText = String(reason || "").slice(0, 120);
        console.log(`gateway closed (${code}) ${reasonText} session=${Boolean(await this.state.storage.get("session-id"))}`);
        this.ws = null;
        this.started = false;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        await this.scheduleReconnect();
    }

    send(payload) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    storeSeq(seq) {
        if (seq != null) {
            this.seq = seq;
            this.state.storage.put("seq", seq);
        }
    }

    handleFrame(frame) {
        if (frame.op !== 11 && !(frame.op === 0 && frame.t !== "READY" && frame.t !== "RESUMED")) {
            console.log(`gateway frame op=${frame.op} t=${frame.t || ""} d=${frame.op === 9 ? JSON.stringify(frame.d) : ""}`);
        }
        this.storeSeq(frame.s ?? this.seq);

        switch (frame.op) {
            case 10: { // HELLO
                this.afterHello(frame.d && frame.d.heartbeat_interval);
                break;
            }
            case 11: { // HEARTBEAT ACK
                this.heartbeatAcked = true;
                break;
            }
            case 7: { // RECONNECT
                try { this.ws && this.ws.close(1000, "server requested reconnect"); } catch { /* */ }
                break;
            }
            case 9: { // INVALID_SESSION
                this.invalidateSession(Boolean(frame.d));
                break;
            }
            case 0: { // DISPATCH
                this.onDispatch(frame.t, frame.d);
                break;
            }
            default:
                break;
        }
    }

    async afterHello(intervalMs) {
        const interval = intervalMs || 41250;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(() => {
            if (!this.heartbeatAcked) {
                try { this.ws && this.ws.close(4009, "no heartbeat ack"); } catch { /* */ }
                return;
            }
            this.heartbeatAcked = false;
            this.send({ op: 1, d: this.seq ?? null });
        }, interval);

        const sessionId = await this.state.storage.get("session-id");
        const seq = await this.state.storage.get("seq");
        if (sessionId && seq != null) {
            this.send({
                op: 6, // RESUME
                d: {
                    token: this.env.DISCORD_TOKEN,
                    session_id: sessionId,
                    seq
                }
            });
            return;
        }

        const last = (await this.state.storage.get("last-identify-at")) || 0;
        if (Date.now() - last < IDENTIFY_MIN_GAP) {
            console.log("gateway: identify deferred (rate-limit cadence)");
            try { this.ws && this.ws.close(4000, "identify deferred"); } catch { /* */ }
            return;
        }
        await this.state.storage.put("last-identify-at", Date.now());
        this.send({
            op: 2,
            d: {
                token: this.env.DISCORD_TOKEN,
                intents: INTENTS,
                properties: { os: "linux", browser: "ivorist", device: "ivorist" },
                presence: {
                    status: "online",
                    since: Date.now(),
                    activities: [{ name: "Ivorist Ops", type: 0 }],
                    afk: false
                }
            }
        });
    }

    async invalidateSession(resumable) {
        try {
            const info = await rest(this.env, "GET", "/gateway/bot");
            console.log(`gateway bot info: status=${info.status} limit=${JSON.stringify(info.data && info.data.session_start_limit)} err=${info.error || ""}`);
        } catch { /* diagnostics */ }
        if (!resumable) {
            this.sessionId = null;
            this.seq = null;
            this.resumeUrl = null;
            await this.state.storage.delete("session-id");
            await this.state.storage.delete("seq");
            await this.state.storage.delete("resume-url");
        }
        this.started = false;
        try { this.ws && this.ws.close(4000, "invalid session"); } catch { /* */ }
    }

    onDispatch(t, d) {
        if (t === "READY") {
            this.sessionId = d.session_id;
            this.backoffMs = 2000;
            this.state.storage.put("session-id", d.session_id);
            const base = String(d.resume_gateway_url || "").replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
            this.state.storage.put("resume-url", `wss://${base}/?v=10&encoding=json`);
            console.log(`gateway READY as ${d.user && d.user.username}`);
            return;
        }
        if (t === "RESUMED") {
            this.backoffMs = 2000;
            console.log("gateway RESUMED");
            return;
        }
        if (t === "INTERACTION_CREATE") {
            this.handleInteraction(d).catch((error) => {
                console.error("interaction failed:", String(error).slice(0, 220));
            });
            return;
        }
        if (t === "MESSAGE_CREATE") {
            if (d && d.author && !d.author.bot && d.guild_id) {
                this.handleChannelMessage(d).catch((error) => {
                    console.error("message handling failed:", String(error).slice(0, 220));
                });
            }
        }
    }

    ctxFor() {
        const state = this.state;
        return {
            waitUntil: (promise) => {
                try { state.waitUntil(promise); } catch { /* older runtimes */ }
            }
        };
    }

    /* ==================== REST helpers ==================== */

    async respondCallback(interaction, payload) {
        return rest(this.env, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, payload);
    }

    async followup(interaction, messagePayload) {
        return rest(this.env, "POST", `/webhooks/${interaction.application_id}/${interaction.token}`, messagePayload);
    }

    async postNote(channelId, text) {
        await rest(this.env, "POST", `/channels/${channelId}/messages`, { content: text });
    }

    async fetchFullMessage(channelId, messageId) {
        const res = await rest(this.env, "GET", `/channels/${channelId}/messages/${messageId}`);
        return res.ok ? res.data : null;
    }

    userTagOf(interaction) {
        return interaction.member?.user?.username || interaction.user?.username || "unknown";
    }

    userNameOf(d) {
        return d.member?.user?.username || d.author?.username || "unknown";
    }

    userIdOf(info) {
        return info.member?.user?.id || info.user?.id || info.author?.id || "0";
    }

    channelGate(interaction, channelVar) {
        const expected = this.env[channelVar];
        if (expected && interaction.channel_id !== expected) {
            return `✖ this command belongs in <#${expected}>`;
        }
        return null;
    }

    /* ==================== slash commands ==================== */

    async handleInteraction(interaction) {
        if (interaction.type === 5) {
            return this.handleModalSubmit(interaction);
        }
        if (interaction.type !== 2 || !interaction.data?.name) {
            return;
        }
        const name = interaction.data.name;
        const opts = {};
        for (const o of interaction.data?.options || []) {
            opts[o.name] = o.value;
        }

        if (MODALS[name]) {
            const gate = {
                create: "CHANNEL_APP",
                project: "CHANNEL_PROJECT",
                change: "CHANNEL_CHANGE",
                bank: "CHANNEL_BANK"
            }[name];
            const err = this.channelGate(interaction, gate);
            if (err) {
                return this.respondCallback(interaction, { type: 4, data: { content: err } });
            }
            return this.respondCallback(interaction, openModal(name));
        }

        if (name === "ping") {
            const aliveTs = await this.getRunnerAlive();
            const alive = aliveTs && (Date.now() - aliveTs < 600000);
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    content:
                        `🟢 bot (Cloudflare gateway): online\n` +
                        `🟡 state store: ready (Durable Object)\n` +
                        `● runner (build machine): ${alive ? "online — jobs execute immediately" : "offline — jobs queue until it is back"}`
                }
            });
        }

        if (name === "apps") {
            const apps = await this.getApps();
            if (!apps.length) {
                return this.respondCallback(interaction, {
                    type: 4,
                    data: { content: "📭 no web apps deployed yet — run `/create` in <#" + (this.env.CHANNEL_APP || "") + ">" }
                });
            }
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    embeds: [{
                        title: "Deployed web apps",
                        color: 0x2f6b49,
                        fields: apps.slice(-20).reverse().map((a) => ({
                            name: a.slug,
                            value: `<${a.url}> • branch \`${a.branch}\``,
                            inline: false
                        }))
                    }]
                }
            });
        }

        if (name === "status") {
            let job = null;
            if (opts.job_id) {
                job = await this.getJob(String(opts.job_id).trim());
            } else {
                const jobs = await this.listJobs(1);
                job = jobs[0] || null;
            }
            if (!job) {
                return this.respondCallback(interaction, { type: 4, data: { content: "ℹ no such job" } });
            }
            return this.respondCallback(interaction, { type: 4, data: { embeds: [trackerEmbed(job)] } });
        }

        if (name === "log") {
            const jobs = await this.listJobs(10);
            if (!jobs.length) {
                return this.respondCallback(interaction, { type: 4, data: { content: "📭 no jobs yet. Use `/create`, `/project`, `/change` or `/bank`." } });
            }
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    embeds: [{
                        title: "Recent jobs",
                        color: 0x2f6b49,
                        fields: jobs.map((j) => ({
                            name: `${j.id} — ${j.title}`,
                            value: `${TYPE_LABELS[j.type] || j.type} • **${j.status}** • by ${j.userTag} • <t:${Math.floor(j.createdAt / 1000)}:R>`,
                            inline: false
                        }))
                    }]
                }
            });
        }

        if (name === "clear" || name === "kill" || name === "cancel") {
            const targetId = opts.job_id ? String(opts.job_id).trim() : null;
            if (targetId) {
                const res = await killJob(this.env, targetId, `killed via /${name} by ${this.userTagOf(interaction)}`);
                if (!res.ok) {
                    return this.respondCallback(interaction, { type: 4, data: { content: `✖ could not kill job \`${targetId}\`: ${res.error}` } });
                }
                return this.respondCallback(interaction, {
                    type: 4,
                    data: { content: `🛑 **Job \`${targetId}\` was killed immediately.** Pipeline execution aborted.` }
                });
            } else {
                // If no specific job_id is passed, find the most recent active or pending job, or clear all jobs if requested
                if (name === "clear") {
                    const clearRes = await this.clearAllJobs();
                    return this.respondCallback(interaction, {
                        type: 4,
                        data: { content: `🧹 **Cleared ${clearRes.cleared} job(s) from state.** All queues and pending tasks wiped.` }
                    });
                }
                const jobs = await this.listJobs(10);
                const activeJob = jobs.find((j) => j.status === "running" || j.status === "pending" || j.status === "awaiting");
                if (!activeJob) {
                    return this.respondCallback(interaction, { type: 4, data: { content: "ℹ no active or pending jobs to kill." } });
                }
                const res = await killJob(this.env, activeJob.id, `killed via /${name} by ${this.userTagOf(interaction)}`);
                return this.respondCallback(interaction, {
                    type: 4,
                    data: { content: `🛑 **Active job \`${activeJob.id}\` (${activeJob.title}) killed immediately.** Pipeline execution aborted.` }
                });
            }
        }

        return this.respondCallback(interaction, { type: 4, data: { content: `⁉ unknown command: ${name}` } });
    }

    /* ==================== form submissions ==================== */

    async bindUser(userId, jobId, type, ttlMinutes) {
        const ttl = Math.min(Math.max(Number(ttlMinutes) || 30, 1), 90) * 60;
        await this.putBind(userId, {
            jobId,
            type: type || "",
            expiry: Date.now() + ttl * 1000
        });
    }

    async unbindUser(userId) {
        await this.deleteBind(userId);
    }

    async attachFilesToJob(jobId, entries, filename) {
        const job = await this.getJob(jobId);
        if (!job) {
            return { ok: false, error: "unknown job" };
        }
        if (!["app", "project", "change"].includes(job.type)) {
            return { ok: false, error: "this job type does not take files" };
        }
        if (!["awaiting", "pending"].includes(job.status)) {
            return { ok: false, error: `job is ${job.status}, not awaiting files` };
        }
        let zip;
        let finalFilename = filename;
        if (entries.length === 1 && entries[0].name.toLowerCase().endsWith(".zip")) {
            zip = entries[0].data instanceof Uint8Array ? entries[0].data : new Uint8Array(entries[0].data);
            finalFilename = entries[0].name;
        } else {
            zip = createZipStore(entries);
        }
        if (zip.byteLength > LIMITS.maxZipBytes) {
            return { ok: false, error: "attachment bundle over the size cap" };
        }
        await this.env.BLOBS.put(`zips/${job.id}/${finalFilename}`, zip);
        const updated = await this.patchJob(job.id, {
            fileName: finalFilename,
            fileSize: zip.byteLength,
            textOnly: false,
            status: "pending"
        });
        const currentJob = updated || { ...job, fileName: finalFilename, fileSize: zip.byteLength, textOnly: false, status: "pending" };
        await patchTracker(this.env, currentJob);
        if (!currentJob.aiReview) {
            this.ctxFor().waitUntil(reviewJobWithAI(this.env, currentJob).catch(() => {}));
        }
        return { ok: true, count: entries.length };
    }

    async handleModalSubmit(interaction) {
        if (!String(interaction.data?.custom_id || "").startsWith("ivorist:")) {
            return;
        }
        const command = String(interaction.data.custom_id).replace("ivorist:", "");
        const v = modalValues(interaction);
        const userTag = this.userTagOf(interaction);
        const userId = this.userIdOf(interaction);

        if (command === "create") {
            const slug = slugChecks(v.subdomain);
            if (!slug.ok) {
                return this.respondCallback(interaction, { type: 4, data: { content: `✖ ${slug.reason}` } });
            }
            const res = await createJob(this.env, this.ctxFor(), {
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
                return this.respondCallback(interaction, { type: 4, data: { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` } });
            }
            await this.bindUser(userId, res.jobId, "app", 30);
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    content:
                        `🧾 job \`${res.jobId}\` — form queued for **https://${slug.subdomain}.ivorists.com**!\n` +
                        `▶ **Pipeline started immediately.** (Optional: reply in this channel with custom files/zip within 30 min to customize the app).`
                }
            });
        }

        if (command === "project") {
            if (!v.name || !v.summary) {
                return this.respondCallback(interaction, { type: 4, data: { content: "✖ name and summary are required" } });
            }
            const res = await createJob(this.env, this.ctxFor(), {
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
                return this.respondCallback(interaction, { type: 4, data: { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` } });
            }
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    content:
                        `🧾 job \`${res.jobId}\` — **${v.name.slice(0, 60)}** entered the pipeline. No files attached: the project page is generated entirely from this form.\n` +
                        `Follow the tracker embed in this channel.`
                }
            });
        }

        if (command === "change") {
            if (!v.summary) {
                return this.respondCallback(interaction, { type: 4, data: { content: "✖ summary is required" } });
            }
            const res = await createJob(this.env, this.ctxFor(), {
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
                return this.respondCallback(interaction, { type: 4, data: { content: `ℹ duplicate submission — job \`${res.jobId}\` already handles it` } });
            }
            await this.bindUser(userId, res.jobId, "change", 30);
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    content:
                        `🧾 job \`${res.jobId}\` — change request queued: **${v.summary.slice(0, 300)}**\n` +
                        `▶ **Pipeline started immediately.** (Optional: reply in this channel with custom files to apply).`
                }
            });
        }

        if (command === "bank") {
            if (!v.account) {
                return this.respondCallback(interaction, { type: 4, data: { content: "✖ account/purpose is required" } });
            }
            const res = await createJob(this.env, this.ctxFor(), {
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
            return this.respondCallback(interaction, {
                type: 4,
                data: {
                    embeds: [{
                        title: "Ivorist Bank — request logged",
                        color: 0x2f6b49,
                        description:
                            `🏦 **Ivorist Bank is coming soon.** Your request was stored in the ops log and will be processed when the treasury launches.\n\n` +
                            `**account/purpose:** ${v.account.slice(0, 100)}${v.amount ? `\n**amount:** ${String(v.amount).slice(0, 40)}` : ""}${v.note ? `\n**details:** ${String(v.note).slice(0, 400)}` : ""}\n\n` +
                            `job id: \`${res.jobId}\` • find it any time with \`/log\``,
                        footer: { text: "Ivorist Ops" }
                    }]
                }
            });
        }

        return this.respondCallback(interaction, { type: 4, data: { content: "⁉ unknown form" } });
    }

    /* ==================== channel messages ==================== */

    operationsChannels() {
        const env = this.env;
        return new Set([env.CHANNEL_APP, env.CHANNEL_PROJECT, env.CHANNEL_CHANGE, env.CHANNEL_BANK].filter(Boolean));
    }

    typeForChannel(channelId) {
        const env = this.env;
        if (channelId === env.CHANNEL_APP) return "app";
        if (channelId === env.CHANNEL_PROJECT) return "project";
        if (channelId === env.CHANNEL_CHANGE) return "change";
        return null;
    }

    async handleChannelMessage(message) {
        const full = await this.fetchFullMessage(message.channel_id, message.id);
        const msg = full || message;
        if (msg.author && msg.author.bot) {
            return;
        }
        const atts = msg.attachments || [];
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        const userId = msg.author?.id || "0";

        // 1) bound delivery for an open form
        const bind = await this.getBind(userId);
        if (bind) {
            if (text.toLowerCase().startsWith("cancel")) {
                await this.unbindUser(userId);
                await this.postNote(message.channel_id,
                    `✖ form for job \`${bind.jobId}\` cancelled — the job will expire unused.`);
                return;
            }
            if (atts.length) {
                const handled = await this.deliverBindFiles(message.channel_id, userId, bind, atts);
                if (handled) {
                    return;
                }
            }
        }

        // 2) ad-hoc zip drop
        const type = this.typeForChannel(message.channel_id);
        if (!type || !atts.length) {
            return;
        }
        const zipAtt = atts.find((a) => a && String(a.name || "").toLowerCase().endsWith(".zip"));
        if (!zipAtt) {
            const hasGuidance = await this.getGuidance(message.channel_id);
            if (!hasGuidance) {
                await this.putGuidance(message.channel_id, 120);
                await this.postNote(message.channel_id,
                    `ℹ to submit **${TYPE_LABELS[type]}s** without a zip, run \`/${type === "app" ? "create" : type}\` first — the form binds your next message with any files.`);
            }
            return;
        }
        if ((zipAtt.size || 0) > LIMITS.maxZipBytes) {
            await this.postNote(message.channel_id,
                `✖ ${zipAtt.name} is ${((zipAtt.size || 0) / 1048576).toFixed(1)} MB — the cap is ${(LIMITS.maxZipBytes / 1048576).toFixed(0)} MB.`);
            return;
        }

        const base = String(zipAtt.name).replace(/\.zip$/i, "").toLowerCase();
        const check = type === "app" ? slugChecks(base) : { ok: true, subdomain: "" };
        if (!check.ok) {
            await this.postNote(message.channel_id,
                `✖ "${base}" is not a usable subdomain (3-32 chars, a-z0-9-). Run \`/create\` and fill the form instead.`);
            return;
        }

        let bytes;
        try {
            const res = await fetch(zipAtt.url);
            if (!res.ok) {
                return;
            }
            bytes = await res.arrayBuffer();
        } catch {
            return;
        }

        const opts = type === "app"
            ? {
                type: "app",
                subdomain: check.subdomain,
                name: base,
                description: text.slice(0, 400) || `zip dropped in <#${message.channel_id}>`
            }
            : type === "project"
                ? {
                    type: "project",
                    name: base,
                    category: "Software",
                    summary: `project submitted via zip drop ${base}`,
                    description: text.slice(0, 400)
                }
                : {
                    type: "change",
                    name: base,
                    summary: text.slice(0, 300) || `change submitted via zip drop ${base}`
                };

        const res = await createJob(this.env, this.ctxFor(), {
            type,
            userTag: this.userNameOf(msg),
            userId,
            dedupeKey: msg.id,
            opts,
            fileName: zipAtt.name,
            fileBytes: bytes
        });
        if (res.duplicate) {
            await this.postNote(message.channel_id, `ℹ duplicate submission — job \`${res.jobId}\` already handles it`);
            return;
        }
        await this.postNote(message.channel_id,
            `🧾 job \`${res.jobId}\` queued from the ${TYPE_LABELS[type].toLowerCase()} drop — tracker embed follows.`);
    }

    async deliverBindFiles(channelId, userId, bind, atts) {
        if (!bind || !bind.jobId) {
            return false;
        }
        let total = 0;
        for (const a of atts) {
            const fileName = a.name || a.filename || "file";
            total += a.size || 0;
            if ((a.size || 0) > LIMITS.maxZipBytes) {
                await this.postNote(channelId,
                    `✖ ${fileName} is ${((a.size || 0) / 1048576).toFixed(1)} MB — the cap is ${(LIMITS.maxZipBytes / 1048576).toFixed(0)} MB.`);
                return true;
            }
        }
        if (total > LIMITS.maxZipBytes) {
            await this.postNote(channelId,
                `✖ ${atts.length} files total ${(total / 1048576).toFixed(1)} MB — over the ${(LIMITS.maxZipBytes / 1048576).toFixed(0)} MB cap.`);
            return true;
        }

        const entries = [];
        const used = new Set();
        for (const a of atts) {
            const fileName = a.name || a.filename || "file";
            try {
                const res = await fetch(a.url || a.proxy_url);
                if (!res.ok) {
                    await this.postNote(channelId, `⛔ could not download ${fileName} (HTTP ${res.status})`);
                    return true;
                }
                entries.push({ name: this.safeEntryName(fileName, used), data: await res.arrayBuffer() });
            } catch (error) {
                await this.postNote(channelId, `⛔ could not download ${fileName}: ${String(error).slice(0, 140)}`);
                return true;
            }
        }

        const result = await this.attachFilesToJob(bind.jobId, entries, `bindings-${bind.jobId}.zip`);
        if (!result.ok) {
            await this.postNote(channelId, `⛔ could not attach the files to \`${bind.jobId}\`: ${result.error}`);
            return true;
        }
        await this.unbindUser(userId);
        await this.postNote(channelId,
            `📦 ${result.count} file(s) bound to job \`${bind.jobId}\` — pipeline started, follow the tracker in this channel.`);
        return true;
    }

    safeEntryName(name, used) {
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
}
