import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { createZipStore } from "../src/zipstore.js";
import { GatewayBot, MODALS, openModal, modalValues } from "../src/gateway.js";
import worker from "../src/index.js";
import {
    rest,
    createJob,
    getJob,
    listJobs,
    popQueue,
    getRunnerAlive,
    setRunnerAlive,
    bindUser,
    getBind,
    patchJob,
    trackerEmbed,
    reviewJobWithAI
} from "../src/jobs.js";

// Mock R2 storage
function createMockR2() {
    const store = new Map();
    return {
        async get(key) {
            if (!store.has(key)) return null;
            return { body: store.get(key) };
        },
        async put(key, data) {
            store.set(key, data);
        },
        _store: store
    };
}

// Mock Durable Object storage
function createMockDOStorage() {
    const map = new Map();
    let alarm = null;
    let putCount = 0;
    return {
        async get(key) {
            return map.has(key) ? map.get(key) : null;
        },
        async put(key, value) {
            putCount++;
            map.set(key, value);
        },
        async delete(key) {
            map.delete(key);
        },
        async list({ prefix = "" } = {}) {
            const out = new Map();
            for (const [k, v] of map.entries()) {
                if (k.startsWith(prefix)) {
                    out.set(k, v);
                }
            }
            return out;
        },
        async setAlarm(time) {
            alarm = time;
        },
        getAlarm() {
            return alarm;
        },
        getPutCount() {
            return putCount;
        },
        _map: map
    };
}

function createTestEnv(overrides = {}) {
    const storage = createMockDOStorage();
    const r2 = createMockR2();
    const env = {
        DISCORD_TOKEN: "valid-bot-token",
        DISCORD_PUBLIC_KEY: "",
        RUNNER_TOKEN: "test-runner-token",
        GATEWAY_ENABLED: "1",
        BLOBS: r2,
        ...overrides
    };
    const bot = new GatewayBot({ storage }, env);
    env._bot = bot;
    env._storage = storage;
    env.GATEWAY = {
        idFromName(name) { return name; },
        get(id) {
            return {
                async fetch(url, init = {}) {
                    const req = new Request(url, init);
                    return bot.fetch(req);
                }
            };
        }
    };
    return { env, bot, storage, r2 };
}

test("zipstore: generates valid store zip with multiple files", () => {
    const entries = [
        { name: "index.html", data: "<h1>Hello</h1>" },
        { name: "style.css", data: "body { color: red; }" }
    ];
    const zipBytes = createZipStore(entries);
    assert.ok(zipBytes instanceof Uint8Array);
    assert.ok(zipBytes.length > 50);

    // Local file header signature: 0x04034b50 (little endian: 0x50, 0x4b, 0x03, 0x04)
    assert.equal(zipBytes[0], 0x50);
    assert.equal(zipBytes[1], 0x4b);
    assert.equal(zipBytes[2], 0x03);
    assert.equal(zipBytes[3], 0x04);

    // End of central directory signature: 0x06054b50 (0x50, 0x4b, 0x05, 0x06)
    const eocdSig = [0x50, 0x4b, 0x05, 0x06];
    let foundEocd = false;
    for (let i = 0; i < zipBytes.length - 4; i++) {
        if (zipBytes[i] === eocdSig[0] &&
            zipBytes[i + 1] === eocdSig[1] &&
            zipBytes[i + 2] === eocdSig[2] &&
            zipBytes[i + 3] === eocdSig[3]) {
            foundEocd = true;
            break;
        }
    }
    assert.ok(foundEocd, "EOCD signature should exist");
});

test("gateway: connect uses https scheme and headers.Upgrade = 'websocket'", async () => {
    const { bot } = createTestEnv();

    let fetchedUrl = null;
    let fetchedInit = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        fetchedUrl = url;
        fetchedInit = init;
        return {
            webSocket: {
                accept() {},
                addEventListener() {},
                close() {}
            }
        };
    };

    try {
        await bot.connect();
        assert.ok(fetchedUrl, "fetch should be called");
        assert.ok(fetchedUrl.startsWith("https://"), `Url must start with https://, got: ${fetchedUrl}`);
        assert.equal(fetchedInit?.headers?.Upgrade, "websocket", "Upgrade: websocket must be inside headers");
        assert.equal(bot.started, true, "bot should be started");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("gateway: handleClose resets this.started to false and doubles backoff", async () => {
    const { bot } = createTestEnv();
    bot.started = true;
    bot.backoffMs = 2000;

    await bot.handleClose(1006, "abnormal closure");
    assert.equal(bot.started, false, "started must be reset to false on close");
    assert.equal(bot.backoffMs, 4000, "backoffMs must double to 4000");

    await bot.scheduleReconnect();
    assert.equal(bot.backoffMs, 8000, "backoffMs must double to 8000 on next reconnect");
});

test("gateway: invalidateSession clears in-memory state and resets started flag", async () => {
    const { bot, storage } = createTestEnv();
    await storage.put("session-id", "sess-123");
    await storage.put("seq", 42);
    await storage.put("resume-url", "wss://resume.discord.gg");

    bot.sessionId = "sess-123";
    bot.seq = 42;
    bot.resumeUrl = "wss://resume.discord.gg";
    bot.started = true;

    await bot.invalidateSession(false);

    assert.equal(bot.sessionId, null, "sessionId must be null");
    assert.equal(bot.seq, null, "seq must be null");
    assert.equal(bot.resumeUrl, null, "resumeUrl must be null");
    assert.equal(bot.started, false, "started must be false");
    assert.equal(await storage.get("session-id"), null, "stored session-id must be deleted");
});

test("gateway: attachFilesToJob does not wrap single zip in another zip", async () => {
    const { env, bot, r2 } = createTestEnv({ CHANNEL_APP: "chan-app" });

    // Create an awaiting app job
    const jobRes = await createJob(env, { waitUntil() {} }, {
        type: "app",
        userTag: "alice",
        userId: "u1",
        opts: { subdomain: "cool-app", name: "cool-app" },
        fileName: null,
        fileBytes: null
    });
    const job = await getJob(env, jobRes.jobId);
    assert.equal(job.status, "pending");

    // Single zip file
    const fakeZipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99, 0x88]);
    const singleZipEntries = [{ name: "my-app.zip", data: fakeZipBytes }];

    const attachRes1 = await bot.attachFilesToJob(job.id, singleZipEntries, "bindings-fallback.zip");
    assert.equal(attachRes1.ok, true);

    const updatedJob = await getJob(env, job.id);
    assert.equal(updatedJob.fileName, "my-app.zip", "job.fileName should be original single zip name");
    assert.equal(updatedJob.status, "pending");

    const storedBlob = r2._store.get(`zips/${job.id}/my-app.zip`);
    assert.deepEqual(storedBlob, fakeZipBytes, "stored blob must match raw zip bytes byte-for-byte");
});

test("gateway: attachFilesToJob wraps multiple files into createZipStore archive", async () => {
    const { env, bot, r2 } = createTestEnv({ CHANNEL_APP: "chan-app" });

    const jobRes = await createJob(env, { waitUntil() {} }, {
        type: "app",
        userTag: "bob",
        userId: "u2",
        opts: { subdomain: "multi-file", name: "multi-file" },
        fileName: null,
        fileBytes: null
    });

    const entries = [
        { name: "index.html", data: "<h1>Hello</h1>" },
        { name: "script.js", data: "console.log('hi');" }
    ];

    const attachRes = await bot.attachFilesToJob(jobRes.jobId, entries, `bindings-${jobRes.jobId}.zip`);
    assert.equal(attachRes.ok, true);

    const updatedJob = await getJob(env, jobRes.jobId);
    assert.equal(updatedJob.fileName, `bindings-${jobRes.jobId}.zip`);

    const storedBlob = r2._store.get(`zips/${jobRes.jobId}/bindings-${jobRes.jobId}.zip`);
    assert.ok(storedBlob instanceof Uint8Array);
    assert.equal(storedBlob[0], 0x50);
    assert.equal(storedBlob[1], 0x4b);
});

test("index: /healthz reports gateway status, runner, and discord using DO storage", async () => {
    const { env, storage } = createTestEnv();
    await storage.put("runner:alive", Date.now());
    await storage.put("session-id", "sess-abc");

    const req = new Request("https://worker.test/healthz");
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();

    assert.equal(data.ok, true);
    assert.equal(data.discord, "ready");
    assert.equal(data.gateway, "idle");
    assert.equal(data.runner, "online");
});

test("index: /gateway/ensure and /gateway/start invoke DO stub", async () => {
    const { env, storage } = createTestEnv();
    await storage.put("session-id", "sess-1");

    const req = new Request("https://worker.test/gateway/ensure");
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();

    assert.equal(data.sessionId, "sess-1");
});

test("index: scheduled event fetches DO stub /ensure and requeueStale", async () => {
    const { env, bot } = createTestEnv();
    let ensured = false;
    const origEnsure = bot.ensure.bind(bot);
    bot.ensure = async () => {
        ensured = true;
        return origEnsure();
    };

    let waitPromise = null;
    await worker.scheduled({}, env, {
        waitUntil(p) { waitPromise = p; }
    });
    if (waitPromise) await waitPromise;

    assert.equal(ensured, true, "scheduled() must call stub ensure");
});

test("index: /interactions handles PING (type 1)", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

    const payload = JSON.stringify({ type: 1 });
    const ts = "123456";
    const sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);
    const sigHex = Buffer.from(sig).toString("hex");

    const req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": sigHex,
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    const { env } = createTestEnv({ DISCORD_PUBLIC_KEY: pubKeyHex });
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();

    assert.equal(data.type, 1, "PONG response must be { type: 1 }");
});

test("index: /interactions returns Modal (type 9) on slash command /create", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

    const interaction = {
        type: 2,
        id: "int-1",
        data: { name: "create", options: [] },
        channel_id: "chan-app"
    };
    const payload = JSON.stringify(interaction);
    const ts = "123456";
    const sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);
    const sigHex = Buffer.from(sig).toString("hex");

    const req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": sigHex,
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    const { env } = createTestEnv({
        DISCORD_PUBLIC_KEY: pubKeyHex,
        CHANNEL_APP: "chan-app"
    });
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();

    assert.equal(data.type, 9, "Modal response must be type 9");
    assert.equal(data.data.custom_id, "ivorist:create");
    assert.ok(data.data.components.length > 0);
});

test("index: /interactions handles modal submit (type 5) for /create and binds user in DO storage", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const { env, storage } = createTestEnv({
        DISCORD_PUBLIC_KEY: pubKeyHex,
        CHANNEL_APP: "chan-app"
    });

    const modalSubmitInteraction = {
        type: 5,
        id: "int-modal-1",
        channel_id: "chan-app",
        member: { user: { id: "user-456", username: "dave" } },
        data: {
            custom_id: "ivorist:create",
            components: [
                { components: [{ custom_id: "subdomain", value: "daves-tool" }] },
                { components: [{ custom_id: "name", value: "Dave's Tool" }] },
                { components: [{ custom_id: "description", value: "Does cool things" }] }
            ]
        }
    };

    const payload = JSON.stringify(modalSubmitInteraction);
    const ts = "123456";
    const sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);
    const sigHex = Buffer.from(sig).toString("hex");

    const req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": sigHex,
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    let waitPromise = null;
    const res = await worker.fetch(req, env, {
        waitUntil(p) { waitPromise = p; }
    });
    if (waitPromise) await waitPromise;

    const data = await res.json();
    assert.equal(data.type, 4, "Interaction callback response should be type 4");
    assert.ok(data.data.content.includes("https://daves-tool.ivorists.com"));

    // Check that bind was created in DO storage
    const bind = await getBind(env, "user-456");
    assert.ok(bind, "bind:user-456 must exist in DO storage");
    assert.equal(bind.type, "app");
    assert.ok(bind.jobId.startsWith("j-"));

    // Check that job was created in DO storage
    const job = await getJob(env, bind.jobId);
    assert.ok(job);
    assert.equal(job.status, "pending");
    assert.equal(job.subdomain, "daves-tool");
});

test("jobs: rest handles 429 rate limit with async timer", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
        callCount++;
        if (callCount === 1) {
            return {
                status: 429,
                ok: false,
                json: async () => ({ retry_after: 0.05 }) // 50ms retry
            };
        }
        return {
            status: 200,
            ok: true,
            json: async () => ({ success: true })
        };
    };

    try {
        const env = { DISCORD_TOKEN: "valid-bot-token" };
        const start = Date.now();
        const res = await rest(env, "POST", "/channels/123/messages", { content: "hi" });
        const elapsed = Date.now() - start;

        assert.equal(res.ok, true);
        assert.equal(callCount, 2, "should retry once after 429");
        assert.ok(elapsed >= 40, `should wait retry_after delay, took ${elapsed}ms`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("index: /interactions channel gate rejects commands in wrong channel", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

    const interaction = {
        type: 2,
        id: "int-wrong-chan",
        data: { name: "create", options: [] },
        channel_id: "wrong-chan-id"
    };
    const payload = JSON.stringify(interaction);
    const ts = "123456";
    const sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);
    const sigHex = Buffer.from(sig).toString("hex");

    const req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": sigHex,
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    const { env } = createTestEnv({
        DISCORD_PUBLIC_KEY: pubKeyHex,
        CHANNEL_APP: "correct-app-chan"
    });
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();

    assert.equal(data.type, 4);
    assert.ok(data.data.content.includes("belongs in <#correct-app-chan>"));
});

test("index: /interactions modal submit validates slug and duplicate submissions via DO", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const { env } = createTestEnv({
        DISCORD_PUBLIC_KEY: pubKeyHex,
        CHANNEL_APP: "chan-app"
    });

    // 1) Invalid slug test
    const invalidSlugInteraction = {
        type: 5,
        id: "int-modal-bad-slug",
        channel_id: "chan-app",
        member: { user: { id: "user-999", username: "eve" } },
        data: {
            custom_id: "ivorist:create",
            components: [
                { components: [{ custom_id: "subdomain", value: "BAD_SLUG!" }] }
            ]
        }
    };

    let payload = JSON.stringify(invalidSlugInteraction);
    let ts = "123456";
    let sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);

    let req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    let res = await worker.fetch(req, env, { waitUntil() {} });
    let data = await res.json();
    assert.equal(data.type, 4);
    assert.ok(data.data.content.startsWith("✖"), "should fail with slug validation error");

    // 2) Valid submission followed by duplicate dedupeKey
    const validInteraction = {
        type: 5,
        id: "int-dedupe-test",
        channel_id: "chan-app",
        member: { user: { id: "user-111", username: "frank" } },
        data: {
            custom_id: "ivorist:create",
            components: [
                { components: [{ custom_id: "subdomain", value: "frank-tool" }] }
            ]
        }
    };

    payload = JSON.stringify(validInteraction);
    sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);

    req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    res = await worker.fetch(req, env, { waitUntil() {} });
    data = await res.json();
    assert.ok(data.data.content.includes("https://frank-tool.ivorists.com"));

    // Submit the exact same interaction again -> duplicate detected
    req = new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    });

    res = await worker.fetch(req, env, { waitUntil() {} });
    data = await res.json();
    assert.ok(data.data.content.includes("duplicate submission"));
});

test("index: /interactions handles project, change, and bank modal submits via DO storage", async () => {
    const keyPair = nacl.sign.keyPair();
    const pubKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const { env } = createTestEnv({
        DISCORD_PUBLIC_KEY: pubKeyHex,
        CHANNEL_PROJECT: "chan-proj",
        CHANNEL_CHANGE: "chan-chg",
        CHANNEL_BANK: "chan-bank"
    });

    // Project submit
    const projInteraction = {
        type: 5,
        id: "int-proj-1",
        channel_id: "chan-proj",
        member: { user: { id: "u-proj", username: "grace" } },
        data: {
            custom_id: "ivorist:project",
            components: [
                { components: [{ custom_id: "name", value: "Project Alpha" }] },
                { components: [{ custom_id: "summary", value: "A breakthrough software engine" }] },
                { components: [{ custom_id: "category", value: "Software" }] },
                { components: [{ custom_id: "tech", value: "JavaScript, Rust" }] }
            ]
        }
    };
    let payload = JSON.stringify(projInteraction);
    let ts = "123456";
    let sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);

    let res = await worker.fetch(new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    }), env, { waitUntil() {} });
    let data = await res.json();
    assert.equal(data.type, 4);
    assert.ok(data.data.content.includes("entered the pipeline"));
    assert.equal(await getBind(env, "u-proj"), null);

    // Change submit
    const chgInteraction = {
        type: 5,
        id: "int-chg-1",
        channel_id: "chan-chg",
        member: { user: { id: "u-chg", username: "heidi" } },
        data: {
            custom_id: "ivorist:change",
            components: [
                { components: [{ custom_id: "summary", value: "Fix navbar typo on homepage" }] }
            ]
        }
    };
    payload = JSON.stringify(chgInteraction);
    sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);

    res = await worker.fetch(new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    }), env, { waitUntil() {} });
    data = await res.json();
    assert.equal(data.type, 4);
    assert.ok(data.data.content.includes("change request"));
    assert.ok(await getBind(env, "u-chg"), "user must be bound for change in DO");

    // Bank submit
    const bankInteraction = {
        type: 5,
        id: "int-bank-1",
        channel_id: "chan-bank",
        member: { user: { id: "u-bank", username: "ivan" } },
        data: {
            custom_id: "ivorist:bank",
            components: [
                { components: [{ custom_id: "account", value: "Ops-Fund-01" }] },
                { components: [{ custom_id: "amount", value: "500 USDC" }] }
            ]
        }
    };
    payload = JSON.stringify(bankInteraction);
    sig = nacl.sign.detached(Buffer.from(ts + payload), keyPair.secretKey);

    res = await worker.fetch(new Request("https://worker.test/interactions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
            "X-Signature-Timestamp": ts
        },
        body: payload
    }), env, { waitUntil() {} });
    data = await res.json();
    assert.equal(data.type, 4);
    assert.ok(data.data.embeds && data.data.embeds.length > 0);
    assert.equal(data.data.embeds[0].title, "Ivorist Bank — request logged");
});

test("nvidia: reviewJobWithAI calls OpenAI-compatible endpoint with correct params and updates embed", async () => {
    const { env, bot } = createTestEnv({
        NVIDIA_API_KEY: "nvapi-test-key-12345"
    });

    let calledUrl = null;
    let calledInit = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === "https://integrate.api.nvidia.com/v1/chat/completions") {
            calledUrl = url;
            calledInit = init;
            const payload = {
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "AI Review: Web app for finance tools. Clean structure and valid requirements."
                        }
                    }
                ]
            };
            return {
                ok: true,
                status: 200,
                json: async () => payload,
                text: async () => JSON.stringify(payload)
            };
        }
        return originalFetch(url, init);
    };

    try {
        const job = {
            id: "j-nvidia-test",
            type: "app",
            status: "pending",
            title: "Finance Tool",
            subdomain: "finance-tool",
            summary: "Simple finance dashboard",
            userTag: "alice",
            steps: {},
            createdAt: Date.now()
        };
        await bot.putJob(job);

        await reviewJobWithAI(env, job);

        assert.equal(calledUrl, "https://integrate.api.nvidia.com/v1/chat/completions");
        assert.equal(calledInit.method, "POST");
        assert.equal(calledInit.headers["Authorization"], "Bearer nvapi-test-key-12345");
        assert.equal(calledInit.headers["Content-Type"], "application/json");

        const parsedBody = JSON.parse(calledInit.body);
        assert.equal(parsedBody.model, "z-ai/glm-5.3-flash");
        assert.equal(parsedBody.temperature, 0.3);
        assert.equal(parsedBody.top_p, 1);
        assert.equal(parsedBody.max_tokens, 300);
        assert.equal(parsedBody.stream, false);
        assert.ok(parsedBody.messages.length >= 2);

        // Verify stored in DO
        const savedJob = await getJob(env, "j-nvidia-test");
        assert.equal(savedJob.aiReview, "AI Review: Web app for finance tools. Clean structure and valid requirements.");

        // Verify embed includes AI review
        const embed = trackerEmbed(savedJob);
        const reviewField = embed.fields.find((f) => f.name === "AI REVIEW");
        assert.ok(reviewField, "AI REVIEW field must be present in embed");
        assert.ok(reviewField.value.includes("Web app for finance tools"));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("do: runner claim performs zero writes on empty poll", async () => {
    const { env, storage } = createTestEnv();

    const putCountBefore = storage.getPutCount();
    const claimedJob = await popQueue(env);

    assert.equal(claimedJob, null, "no job should be claimed when queue empty");
    assert.equal(storage.getPutCount(), putCountBefore, "empty claim must NOT write to DO storage");
});

test("do: runner claim retrieves oldest pending job and sets running status", async () => {
    const { env, bot } = createTestEnv();

    const job1 = {
        id: "j-1",
        type: "app",
        status: "pending",
        title: "Job 1",
        createdAt: 1000,
        steps: {}
    };
    const job2 = {
        id: "j-2",
        type: "app",
        status: "pending",
        title: "Job 2",
        createdAt: 2000,
        steps: {}
    };
    await bot.putJob(job1);
    await bot.putJob(job2);

    const claimed = await popQueue(env);
    assert.ok(claimed);
    assert.equal(claimed.id, "j-1", "FIFO: oldest pending job must be claimed first");
    assert.equal(claimed.status, "running");

    const job1After = await getJob(env, "j-1");
    assert.equal(job1After.status, "running");

    const claimed2 = await popQueue(env);
    assert.ok(claimed2);
    assert.equal(claimed2.id, "j-2");

    const claimed3 = await popQueue(env);
    assert.equal(claimed3, null);
});

test("do: runner heartbeat records timestamp and healthz reports runner online", async () => {
    const { env } = createTestEnv();

    assert.equal(await getRunnerAlive(env), 0);

    await setRunnerAlive(env, Date.now());
    const alive = await getRunnerAlive(env);
    assert.ok(alive > 0);

    const req = new Request("https://worker.test/healthz");
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const data = await res.json();
    assert.equal(data.runner, "online");
});

test("do: patchJob atomically modifies specified fields without stomping existing state", async () => {
    const { env, bot } = createTestEnv();
    const job = {
        id: "j-patch-test",
        type: "project",
        status: "running",
        title: "Initial Title",
        claimedAt: 123456,
        attempts: 1,
        steps: { "Step 1": { state: "active", detail: "in progress" } }
    };
    await bot.putJob(job);

    const patched = await patchJob(env, "j-patch-test", {
        aiReview: "AI review generated",
        messageId: "msg-999"
    });
    assert.ok(patched);
    assert.equal(patched.status, "running", "status must remain running");
    assert.equal(patched.claimedAt, 123456, "claimedAt must be preserved");
    assert.equal(patched.attempts, 1, "attempts must be preserved");
    assert.equal(patched.aiReview, "AI review generated");
    assert.equal(patched.messageId, "msg-999");
    assert.deepEqual(patched.steps, job.steps);

    const fetched = await getJob(env, "j-patch-test");
    assert.equal(fetched.status, "running");
    assert.equal(fetched.aiReview, "AI review generated");
});

test("nvidia: reviewJobWithAI does not stomp runner status when runner claims job concurrently", async () => {
    const { env, bot } = createTestEnv({
        NVIDIA_API_KEY: "nvapi-test-key-concurrency"
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === "https://integrate.api.nvidia.com/v1/chat/completions") {
            // Simulate AI taking time while runner claims the job
            const stored = await bot.getJob("j-race-test");
            if (stored) {
                stored.status = "running";
                stored.claimedAt = Date.now();
                await bot.putJob(stored);
            }
            const payload = {
                choices: [{ message: { content: "Reviewed: looks great" } }]
            };
            return {
                ok: true,
                status: 200,
                json: async () => payload,
                text: async () => JSON.stringify(payload)
            };
        }
        return originalFetch(url, init);
    };

    try {
        const job = {
            id: "j-race-test",
            type: "app",
            status: "pending",
            title: "Race Test App",
            userTag: "tester",
            createdAt: Date.now()
        };
        await bot.putJob(job);

        // Run review with AI
        await reviewJobWithAI(env, job);

        // Verify the job status is still "running" and was NOT stomped back to "pending"
        const finalJob = await getJob(env, "j-race-test");
        assert.equal(finalJob.status, "running", "status must remain running even after AI review completes");
        assert.equal(finalJob.aiReview, "Reviewed: looks great");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("index: /runner/test-ai calls reviewJobWithAI and returns duration and review", async () => {
    const { env } = createTestEnv({
        NVIDIA_API_KEY: "nvapi-test-key-diag"
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url === "https://integrate.api.nvidia.com/v1/chat/completions") {
            const payload = {
                choices: [{ message: { content: "Diagnostic AI review completed" } }]
            };
            return {
                ok: true,
                status: 200,
                json: async () => payload,
                text: async () => JSON.stringify(payload)
            };
        }
        return originalFetch(url, init);
    };

    try {
        const req = new Request("https://worker.test/runner/test-ai", {
            method: "POST",
            headers: {
                "Authorization": "Bearer test-runner-token"
            }
        });
        const res = await worker.fetch(req, env, { waitUntil() {} });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.equal(data.aiReview, "Diagnostic AI review completed");
        assert.ok(typeof data.durationMs === "number");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
