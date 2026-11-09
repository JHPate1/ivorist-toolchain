import { createJob } from "./jobs.js";
import { slugChecks, LIMITS } from "../../rules.js";

/* =========================================================
   GatewayBot: a Durable Object that holds the Discord
   gateway WebSocket. Keeps the bot member-listed "online"
   24/7 (even while this PC is off) and turns zip attachments
   dropped in the ops channels into queued jobs.
   ========================================================= */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 << 9; // GUILD_MESSAGES (not privileged)

function validToken(env) {
    return env.DISCORD_TOKEN && env.DISCORD_TOKEN !== "set-later";
}

export class GatewayBot {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.ws = null;
        this.seq = null;
        this.sessionId = null;
        this.resumeUrl = null;
        this.heartbeatTimer = null;
        this.heartbeatAcked = true;
        this.started = false;
    }

    /* -------- remote control (called by the worker) -------- */

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/start" || url.pathname === "/ensure") {
            await this.ensure();
            return new Response(JSON.stringify({ active: Boolean(this.ws), sessionId: this.sessionId }), {
                headers: { "Content-Type": "application/json" }
            });
        }
        return new Response("nope", { status: 404 });
    }

    async alarm() {
        // Reconnect timer (set whenever the socket closes or fails).
        await this.ensure(true);
    }

    async ensure(force = false) {
        if (this.ws && this.ws.readyState === 1) {
            return;
        }
        if (!validToken(this.env)) {
            return;
        }
        if (this.started && !force) {
            return;
        }
        this.started = true;
        await this.connect();
    }

    async connect() {
        const headers = { Upgrade: "websocket" };
        let resumeUrl = GATEWAY_URL;
        const stored = await this.state.storage.get("resume-url");
        const sessionId = await this.state.storage.get("session-id");
        const seq = await this.state.storage.get("seq");
        if (sessionId && seq != null) {
            resumeUrl = `${stored || GATEWAY_URL}&session_id=${sessionId}&seq=${seq}`;
        }

        let wsResponse;
        try {
            wsResponse = await fetch(resumeUrl, headers);
        } catch (error) {
            await this.scheduleReconnect();
            return;
        }
        const ws = wsResponse.webSocket;
        if (!ws) {
            await this.scheduleReconnect();
            return;
        }
        ws.accept();
        this.ws = ws;
        this.heartbeatAcked = true;

        ws.addEventListener("message", (event) => {
            try {
                this.handleFrame(JSON.parse(event.data));
            } catch (error) {
                // a malformed frame should never take the socket down
            }
        });

        ws.addEventListener("close", () => {
            this.ws = null;
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
            this.scheduleReconnect();
        });

        ws.addEventListener("error", () => { /* close handler re-connects */ });
    }

    scheduleReconnect() {
        this.state.storage.setAlarm(Date.now() + 15000);
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
        this.storeSeq(frame.s ?? this.seq);

        switch (frame.op) {
            case 10: { // HELLO: start heartbeating + identify/resume
                const interval = frame.d.heartbeat_interval || 41250;
                if (this.heartbeatTimer) {
                    clearInterval(this.heartbeatTimer);
                }
                this.heartbeatTimer = setInterval(() => {
                    if (!this.heartbeatAcked) {
                        // missed ack: hard reconnect
                        try { this.ws.close(4000, "no heartbeat ack"); } catch { /* */ }
                        return;
                    }
                    this.heartbeatAcked = false;
                    this.send({ op: 1, d: this.seq ?? null });
                }, interval);
                if (this.sessionId && this.seq != null) {
                    this.send({
                        op: 6,
                        d: {
                            token: this.env.DISCORD_TOKEN,
                            session_id: this.sessionId,
                            seq: this.seq
                        }
                    });
                } else {
                    this.send({
                        op: 2,
                        d: {
                            token: this.env.DISCORD_TOKEN,
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
                this.heartbeatAcked = true;
                break;
            }
            case 7: // RECONNECT: close + server will reaccept via resume
            case 9: { // INVALID SESSION (non-resumable after op false)
                try { this.ws && this.ws.close(4000, "server asked"); } catch { /* */ }
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

    onDispatch(t, d) {
        if (t === "READY") {
            this.sessionId = d.session_id;
            this.resumeUrl = d.resume_gateway_url;
            this.state.storage.put("session-id", d.session_id);
            this.state.storage.put("resume-url", `wss://${d.resume_gateway_url}/?v=10&encoding=json`);
            return;
        }
        if (t === "RESUMED") {
            return;
        }
        if (t === "MESSAGE_CREATE") {
            this.ctx = null;
            d && d.guild_id && this.handleChannelZip(d);
        }
    }

    /* -------- zip drops in the ops channels -------- */

    ctxFor() {
        // DOs get waitUntil through state
        const state = this.state;
        return {
            waitUntil: (promise) => {
                try { state.waitUntil(promise); } catch { /* older runtimes */ }
            }
        };
    }

    async handleChannelZip(message) {
        const env = this.env;
        const typeByChannel = {
            [env.CHANNEL_APP]: "app",
            [env.CHANNEL_PROJECT]: "project",
            [env.CHANNEL_CHANGE]: "change"
        };
        const type = typeByChannel[message.channel_id];
        if (!type) {
            return;
        }
        const att = (message.attachments || []).find((a) => a && String(a.name).toLowerCase().endsWith(".zip"));
        if (!att) {
            return;
        }
        if ((att.size || 0) > LIMITS.maxZipBytes) {
            await this.postNote(message.channel_id,
                `✖ ${att.name} is ${(att.size / 1048576).toFixed(1)} MB — the limit is ${(LIMITS.maxZipBytes / 1048576).toFixed(0)} MB. Use a smaller zip or \`/change\`.`);
            return;
        }

        const userTag = message.author ? `${message.author.username}` : "unknown";
        let bytes;
        try {
            const res = await fetch(att.url);
            if (!res.ok) {
                return;
            }
            bytes = await res.arrayBuffer();
        } catch (error) {
            return;
        }

        const base = String(att.name).replace(/\.zip$/i, "").toLowerCase();
        const slug = slugChecks(base);

        const opts = type === "app"
            ? (slug.ok
                ? {
                    subdomain: slug.subdomain,
                    name: base,
                    description: (message.content || "").slice(0, 400) || "zip dropped in #deploy-web-app"
                }
                : null)
            : {
                name: base,
                description: (message.content || "").slice(0, 400) || `zip dropped in channel ${message.channel_id}`,
                summary: (message.content || "").slice(0, 400)
            };

        if (type === "app" && !opts) {
            await this.postNote(message.channel_id,
                `✖ "${base}" is not a usable subdomain (3-32 chars, a-z0-9-). Resubmit with \`/create subdomain:… files:…\`.`);
            return;
        }

        await createJob(env, this.ctxFor(), {
            type,
            userTag,
            userId: message.author && message.author.id,
            dedupeKey: message.id,
            opts,
            fileName: att.name,
            fileBytes: bytes
        });
    }

    async postNote(channelId, text) {
        await rest(this.env, "POST", `/channels/${channelId}/messages`, { content: text });
    }
}
