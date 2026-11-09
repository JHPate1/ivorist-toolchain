#!/usr/bin/env node
/* =========================================================
   IVORIST RUNNER
   Local executor for the Ivorist Discord ops toolchain.
   - long-polls the Ivorist Gateway worker for jobs
   - downloads zips to the local temp inbox
   - applies the strict Ivorist rules (files, secrets, safety)
   - rewrites secrets into env vars when a worker is present
   - pushes a branch of the ivorist git repo, then deploys
   - reports every step back so the Discord embed updates live
   Zero npm dependencies: Node 18+ and the OS only.
   ========================================================= */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as rules from "../rules.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const CONFIG_PATH = path.join(HERE, "runner-config.json");

/* -------------------- boot -------------------- */

function readConfigStrict(file) {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    return JSON.parse(text);
}

if (!existsSync(CONFIG_PATH)) {
    console.error("runner-config.json is missing next to runner.js (copy runner-config.example.json).");
    process.exit(1);
}
const config = readConfigStrict(CONFIG_PATH);

const INBOX = config.inboxDir || "C:\\Users\\hemal\\Downloads\\.ivorist-runner";
const SITE_REPO = config.siteRepo || "C:\\Users\\hemal\\Downloads\\ivorist-website";
const WORKER_BASE = config.workerBase;
const TOKEN = config.runnerToken;

if (!WORKER_BASE || !TOKEN) {
    console.error("runner-config.json needs workerBase and runnerToken.");
    process.exit(1);
}

mkdirSync(INBOX, { recursive: true });

git(SITE_REPO, ["config", "user.name", "Ivorist Ops"]);
git(SITE_REPO, ["config", "user.email", "ops@ivorists.com"]);

function api(route, init = {}) {
    const headers = { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) };
    return fetch(WORKER_BASE + route, { ...init, headers });
}

async function post(route, body) {
    const res = await api(route, {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`${route} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return res.json();
}

function progress(jobId, step, state, detail) {
    return post("/runner/progress", { jobId, step, state, detail }).catch((error) => {
        console.error("progress post failed:", String(error).slice(0, 160));
    });
}

function heartbeatLoop() {
    const beat = () => post("/runner/heartbeat", null).catch(() => null);
    beat();
    setInterval(beat, 60 * 1000);
}

/* -------------------- small helpers -------------------- */

function git(repo, args, opts = {}) {
    const res = spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        timeout: 180000,
        ...opts
    });
    return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}`.trim() };
}

function npmWrangler(cwd, args, opts = {}) {
    const res = spawnSync("npx", ["wrangler", ...args], {
        cwd,
        encoding: "utf8",
        timeout: opts.timeout || 240000,
        env: { ...process.env, ...opts.env },
        input: opts.input,
        shell: true
    });
    return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}`.trim() };
}

function walk(dir, base = dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = path.relative(base, full).replace(/\\/g, "/");
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full, base, out);
        } else {
            out.push({ abs: full, rel, size: st.size });
        }
    }
    return out;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}

const TEXT_EXTENSIONS = [
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".md",
    ".txt", ".svg", ".csv", ".xml", ".webmanifest", ".env", ".yml"
];

function readTextSafe(abs) {
    try {
        return readFileSync(abs, "utf8");
    } catch {
        return "";
    }
}

function parseEnvFile(text) {
    const entries = [];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        entries.push({ key, value });
    }
    return entries;
}

// Modal env lines use the exact same NAME=value format as .env files.
function parseEnvLines(text) {
    return parseEnvFile(text);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Text-only project: build the project page straight from the modal form
 * fields (name, summary, category, description, highlights, technologies).
 * Every string is HTML-escaped; the page is static and self-contained.
 */
function generateProjectPage(job) {
    const cat = escapeHtml(job.category || "Software");
    const name = escapeHtml(job.name || job.title || "Untitled project");
    const summary = escapeHtml(job.summary || "");
    const paras = String(job.description || "")
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 20);

    const tech = String(job.technologies || "")
        .split(/[,;\n]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);

    const highlights = String(job.highlights || "")
        .split(/\r?\n/)
        .map((h) => h.trim())
        .filter(Boolean)
        .slice(0, 10);

    const bodyBlocks = [];
    if (highlights.length) {
        bodyBlocks.push(
            `    <ul class=\"highlights\">${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
        );
    }
    for (const p of paras) {
        bodyBlocks.push(`    <p>${escapeHtml(p)}</p>`);
    }
    if (!bodyBlocks.length && summary) {
        bodyBlocks.push(`    <p>${escapeHtml(summary)}</p>`);
    }

    return `<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>${name} — Ivorist</title>
<meta name=\"description\" content=\"${summary}\">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body {
    background: #0a0e0b;
    color: #e7ece9;
    font-family: ui-sans-serif, system-ui, \"Segoe UI\", Arial, sans-serif;
    line-height: 1.65;
    min-height: 100vh;
}
main {
    max-width: 760px;
    margin: 0 auto;
    padding: 64px 24px 96px;
}
.cat {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #34d399;
    font-weight: 600;
}
h1 {
    font-size: clamp(30px, 6vw, 44px);
    margin: 10px 0 14px;
    letter-spacing: -0.02em;
}
.sum {
    font-size: 18px;
    color: #a8b5ae;
    margin-bottom: 34px;
}
hr {
    border: 0;
    border-top: 1px solid #1d2722;
    margin: 30px 0;
}
p { color: #cfd9d3; margin-bottom: 18px; }
.highlights { margin: 0 0 22px; padding-left: 20px; color: #cfd9d3; }
.highlights li { margin-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 30px; }
.chip {
    border: 1px solid #1f3a2d;
    color: #7fd6ab;
    background: #0e1613;
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 13px;
}
footer {
    margin-top: 56px;
    padding-top: 22px;
    border-top: 1px solid #1d2722;
    color: #79857e;
    font-size: 13px;
}
footer a { color: #34d399; text-decoration: none; }
footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
    <div class=\"cat\">${cat}</div>
    <h1>${name}</h1>
    <p class=\"sum\">${summary}</p>
    <hr>
${bodyBlocks.join("\n")}
${tech.length ? `\n    <div class=\"chips\">${tech.map((t) => `<span class=\"chip\">${escapeHtml(t)}</span>`).join("")}</div>\n` : ""}    <footer>Part of the <a href=\"https://ivorists.com/\">Ivorist</a> project index.</footer>
</main>
</body>
</html>
`;
}

/* -------------------- rejection helpers -------------------- */

class Rejection extends Error {
    constructor(message) {
        super(message);
        this.rejection = true;
    }
}

/* =========================================================
   Pipelines
   ========================================================= */

async function runPipeline(job) {
    const steps = rules.pipelineFor(job.type);
    const step0 = steps[0];
    const step1 = steps[1];
    const step2 = steps[2];
    const step3 = steps[3];
    const step4 = steps[4];
    if (!step0) {
        throw new Error(`no pipeline for job type ${job.type} (stored, not executed)`);
    }

    const work = path.join(INBOX, "inbox", job.id);
    const zipPath = path.join(work, job.fileName || "submission.zip");
    const unpack = path.join(work, "unpack");
    if (existsSync(work)) {
        rmSync(work, { recursive: true, force: true });
    }
    mkdirSync(unpack, { recursive: true });

    // ---------------- artifact (optional: text-only forms) ----------------
    let bytes = null;
    if (job.fileName) {
        await progress(job.id, step0, "active", "downloading artifact");
        const res = await api(`/runner/artifact/${job.id}`);
        if (!res.ok) {
            throw new Error(`artifact download failed: HTTP ${res.status}`);
        }
        bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > rules.LIMITS.maxZipBytes) {
            throw new Rejection(`artifact too large: ${(bytes.length / 1048576).toFixed(1)} MB`);
        }
        writeFileSync(zipPath, bytes);

        // ---------------- safe unzip ----------------
        const expand = spawnSync("powershell", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unpack}' -Force`
        ], { encoding: "utf8", timeout: 120000 });
        if (expand.status !== 0) {
            throw new Error(`unzip failed — archive may be corrupt: ${String(expand.stderr).trim().slice(0, 300)}`);
        }
    } else if (job.type === "project") {
        // text-only project form: the page is generated from the submitted fields
        writeFileSync(path.join(unpack, "index.html"), generateProjectPage(job));
        await progress(job.id, step0, "active", "text-only project (generated from the form)");
    } else {
        throw new Rejection("this submission has no files attached — reply with your files in the channel (the form alone is not enough for this job type)");
    }

    const files = walk(unpack);
    if (files.length === 0) {
        throw new Rejection("submission is empty");
    }
    if (files.length > rules.LIMITS.maxFileCount) {
        throw new Rejection(`too many files: ${files.length} (limit ${rules.LIMITS.maxFileCount})`);
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > rules.LIMITS.maxZipBytes * 3) {
        throw new Rejection(`submission extracts to ${(totalBytes / 1048576).toFixed(1)} MB — suspicious expansion`);
    }

    // hard-deny executables anywhere in the submission
    const denied = files.filter((f) => rules.isDeniedExtension(f.rel));
    if (denied.length) {
        throw new Rejection(`non-web executable included: ${denied.slice(0, 3).map((f) => f.rel).join(", ")}${denied.length > 3 ? "…" : ""}`);
    }

    if (job.type === "project" || job.type === "change") {
        // site submissions may not overwrite infra files
        const infraHits = files.filter((f) => hitsForbidden(f.rel));
        if (infraHits.length) {
            throw new Rejection(`these files are owned by site infrastructure and cannot be submitted: ${infraHits.slice(0, 4).map((f) => f.rel).join(", ")}`);
        }
        const badExt = files.filter((f) => !rules.SITE_ALLOWED_EXTENSIONS.includes(path.extname(f.rel).toLowerCase()));
        if (badExt.length) {
            throw new Rejection(`file types not allowed on the site: ${badExt.slice(0, 4).map((f) => f.rel).join(", ")}`);
        }
    }

    await progress(job.id, step0, "done", `${files.length} file(s), ${(totalBytes / 1048576).toFixed(1)} MB`);

    /* =====================================================
       WEB APP  (/create)
       ===================================================== */
    if (job.type === "app") {
        const subdomain = job.subdomain;
        const deploy = path.join(work, "deploy");
        mkdirSync(deploy, { recursive: true });
        copyTree(unpack, deploy);

        const deployFiles = walk(deploy);
        const hasIndex = deployFiles.some((f) => f.rel.toLowerCase() === "index.html");
        const workerEntry = deployFiles.find((f) => f.rel.toLowerCase() === "worker.js");

        if (deployFiles.some((f) => /^wrangler\.(jsonc|toml)$/i.test(f.rel))) {
            throw new Rejection("the zip must not contain its own wrangler.jsonc — Ivorist generates the deploy config");
        }
        if (!hasIndex && !workerEntry) {
            throw new Rejection("a web app must contain index.html at the zip root (or a worker.js entry file)");
        }

        await progress(job.id, step1, "active", "scanning for secrets");

        // secrets policy (modal env lines first, so a bundled .env overrides them)
        const envFiles = deployFiles.filter((f) => f.rel.endsWith(".env") || f.rel.includes(".env"));
        const envEntries = [];
        if (job.envText) {
            envEntries.push(...parseEnvLines(job.envText));
        }
        for (const envFile of envFiles) {
            envEntries.push(...parseEnvFile(readTextSafe(envFile.abs)));
        }
        if (envEntries.some((e) => !(e.key || "").match(/^[A-Za-z_][A-Za-z0-9_]*$/))) {
            throw new Rejection("an .env file has malformed keys — use NAME=value lines");
        }

        const keyMap = Object.fromEntries(envEntries.map((e) => [e.key, e.value]));
        const dangerousKeys = envEntries
            .filter((e) => rules.DANGEROUS_ENV_KEYS.some((d) => d.key === e.key && (e.value || "").length > 0))
            .map((e) => e.key);

        const usedInCode = new Set();
        for (const file of deployFiles) {
            if (!TEXT_EXTENSIONS.includes(path.extname(file.rel).toLowerCase()) && !file.rel.endsWith(".env")) {
                continue;
            }
            const text = readTextSafe(file.abs);
            for (const hit of rules.looksLikeSecretMatch(text)) {
                throw new Rejection(`${file.rel} contains what looks like a real credential (${hit}). Rotate that key and resubmit; secrets belong in .env only.`);
            }
            for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
                usedInCode.add(match[1]);
            }
            for (const match of text.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g)) {
                usedInCode.add(match[1]);
            }
            // catch non-worker client code referencing process.env
            if (!workerEntry && /process\.env\./.test(text)) {
                throw new Rejection(`${file.rel} reads process.env on the client side. Static files cannot hold secrets — add a worker.js and move that call server-side.`);
            }
        }

        const unknownEnvUsage = [...usedInCode].filter((key) => !(key in keyMap) && !["NODE_ENV", "PORT", "DEBUG"].includes(key));
        if (unknownEnvUsage.length) {
            throw new Rejection(`code reads process.env.${unknownEnvUsage[0]} but the zip has no .env value for it. Add ${unknownEnvUsage[0]}=… to .env and resubmit.`);
        }

        // worker apps: bind every referenced .env key plus flagged dangerous keys
        const secretKeys = workerEntry
            ? [...new Set([
                ...dangerousKeys,
                ...([...usedInCode].filter((key) => key in keyMap && !["NODE_ENV", "PORT", "DEBUG"].includes(key)))
            ])]
            : [];
        if (!workerEntry && dangerousKeys.length) {
            throw new Rejection(`static app but .env contains sensitive keys (${dangerousKeys.join(", ")}). Secrets cannot ship in public files: add a worker.js that consumes them server-side, or drop the keys.`);
        }

        // rewrite worker code: process.env.X -> env.X and (request) -> (request, env)
        if (workerEntry) {
            for (const file of deployFiles) {
                if (![".js", ".mjs", ".cjs"].includes(path.extname(file.rel).toLowerCase())) {
                    continue;
                }
                let text = readTextSafe(file.abs);
                let changed = false;
                for (const key of usedInCode) {
                    const rx1 = new RegExp(`process\\.env\\.${key}`, "g");
                    const rx2 = new RegExp(`process\\.env\\["${key}"\\]|process\\.env\\['${key}'\\]`, "g");
                    if (rx1.test(text) || rx2.test(text)) {
                        text = text.replace(rx1, `env.${key}`).replace(rx2, `env.${key}`);
                        changed = true;
                    }
                }
                const next = patchWorkerSignature(text);
                if (next !== text) {
                    changed = true;
                    text = next;
                }
                if (changed) {
                    writeFileSync(file.abs, text);
                }
            }
            // drop the .env from the deployed bundle; keys live as worker secrets
            for (const envFile of envFiles) {
                rmSync(envFile.abs, { force: true });
            }
        } else {
            // static app: keep only safe env values as non-secret vars
            if (job.envText) {
                for (const { key, value } of parseEnvLines(job.envText)) {
                    if (rules.DANGEROUS_ENV_KEYS.some((d) => d.key === key)) {
                        continue;
                    }
                    staticVars[key] = value;
                }
            }
            for (const envFile of envFiles) {
                for (const { key, value } of parseEnvFile(readTextSafe(envFile.abs))) {
                    if (rules.DANGEROUS_ENV_KEYS.some((d) => d.key === key)) {
                        continue;
                    }
                    staticVars[key] = value;
                }
                rmSync(envFile.abs, { force: true });
            }
        }

        await progress(job.id, step1, "done", workerEntry
            ? `${secretKeys.length} secret(s) bound to the worker env`
            : "no secrets shipped (clean static app)");

        // ---------------- git ----------------
        const branch = `apps/${subdomain}`;
        await progress(job.id, step2, "active", `branch ${branch}`);
        assertCleanRepo();

        git(SITE_REPO, ["fetch", "origin"]);
        git(SITE_REPO, ["checkout", "-B", branch, "origin/main"]);
        mkdirSync(path.join(SITE_REPO, "apps", subdomain), { recursive: true });
        // the deploy dir holds the REWRITTEN code (secrets already extracted,
        // worker signature patched) — commit that version, minus our plumbing
        copyTree(deploy, path.join(SITE_REPO, "apps", subdomain), ["wrangler.jsonc", ".assetsignore", ".wrangler", ".gitignore"]);
        git(SITE_REPO, ["add", "-A", "apps"]);
        if (git(SITE_REPO, ["diff", "--cached", "--quiet"]).code === 0) {
            throw new Error("nothing changed in this submission (identical to the existing branch)");
        }
        const commit = git(SITE_REPO, ["commit", "-m", `app ${subdomain}: ${job.title} (job ${job.id})`]);
        if (commit.code !== 0) {
            throw new Error(`git commit failed: ${commit.out.slice(0, 300)}`);
        }
        const push = git(SITE_REPO, ["push", "origin", branch, "--force-with-lease"]);
        if (push.code !== 0) {
            throw new Error(`git push failed: ${push.out.slice(0, 300)}`);
        }
        git(SITE_REPO, ["checkout", "main"]);
        await progress(job.id, step2, "done", `pushed ${branch}`);

        // ---------------- deploy ----------------
        await progress(job.id, step3, "active", "deploying worker");
        writeDeployConfig(deploy, subdomain, Boolean(workerEntry), secretKeys, staticVars, Object.keys(staticVars).length);

        let deployRes = npmWrangler(deploy, ["deploy"], { timeout: 300000 });
        let urls;
        if (deployRes.code !== 0) {
            // fall back to a workers.dev URL if the custom domain attach fails
            await progress(job.id, step3, "active", "custom domain unavailable, falling back to workers.dev");
            configWithoutCustomDomain(deploy, subdomain);
            deployRes = npmWrangler(deploy, ["deploy"], { timeout: 300000 });
            if (deployRes.code !== 0) {
                git(SITE_REPO, ["checkout", "main"]); // to be safe
                throw new Error(`wrangler deploy failed: ${lastLines(deployRes.out, 400)}`);
            }
            urls = [`https://ivorist-app-${subdomain}.hemalviral2011.workers.dev`];
        } else {
            urls = [`https://${subdomain}.ivorists.com`];
        }

        // Force the explicit zone route (wildcard route would otherwise win).
        await progress(job.id, step3, "active", "forcing zone route");
        const routeNote = await ensureAppRoute(subdomain);
        await progress(job.id, step3, "active", routeNote);

        // bind secrets after first deploy
        if (secretKeys.length) {
            await progress(job.id, step3, "active", `binding ${secretKeys.length} secret(s)`);
            for (const key of secretKeys) {
                const put = npmWrangler(deploy, ["secret", "put", key], { input: keyMap[key], shell: true });
                if (put.code !== 0) {
                    throw new Error(`wrangler secret put ${key} failed: ${lastLines(put.out, 300)}`);
                }
            }
        }
        await progress(job.id, step3, "done", workerEntry ? "app worker live" : "static app live");

        await progress(job.id, step4, "active", urls[0]);
        const verify = await waitUntilOk(urls[0]);
        if (!verify) {
            throw new Error(`deployed but ${urls[0]} did not come up in time`);
        }
        await progress(job.id, step4, "done", "answer ok");

        return {
            status: "done",
            urls,
            branch
        };
    }

    /* =====================================================
       SITE PROJECT (/project)
       ===================================================== */
    if (job.type === "project") {
        const slug = slugify(job.name || job.title);
        if (!slug || !/^[a-z0-9-]{3,40}$/.test(slug)) {
            throw new Rejection("project name produced no usable slug; use letters and numbers");
        }
        if (!files.some((f) => f.rel.toLowerCase() === "index.html")) {
            throw new Rejection("a project submission must include index.html at the zip root — that page becomes the project's site entry");
        }
        await progress(job.id, step1, "active", "scanning contents");
        const textFiles = files.filter((f) => TEXT_EXTENSIONS.includes(path.extname(f.rel).toLowerCase()));
        for (const file of textFiles) {
            const hits = rules.looksLikeSecretMatch(readTextSafe(file.abs));
            if (hits.length) {
                throw new Rejection(`${file.rel} looks like it contains a live credential (${hits[0]}). Rotate the key and resubmit.`);
            }
        }
        await progress(job.id, step1, "done", "contents clean");

        const branch = `projects/${slug}`;
        await progress(job.id, step2, "active", `branch ${branch}`);
        assertCleanRepo();
        git(SITE_REPO, ["fetch", "origin"]);
        git(SITE_REPO, ["checkout", "-B", branch, "origin/main"]);
        copyTreeTo(SITE_REPO, unpack, ["projects", slug].join(path.sep));
        git(SITE_REPO, ["add", "-A", "projects"]);

        // register in projects.json (site renders it dynamically)
        const pjPath = path.join(SITE_REPO, "projects.json");
        if (existsSync(pjPath)) {
            const data = JSON.parse(readFileSync(pjPath, "utf8"));
            const projects = Array.isArray(data.projects) ? data.projects : [];
            const exists = projects.find((p) => p.id === slug);
            const highest = projects.reduce((max, p) => Math.max(max, parseInt(p.number || "0", 10) || 0), 0);
            const techList = Array.isArray(job.technologies)
                ? job.technologies
                : String(job.technologies || "").split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
            const highList = Array.isArray(job.highlights)
                ? job.highlights
                : String(job.highlights || "").split(/\r?\n/).map((h) => h.trim()).filter(Boolean);
            const entry = {
                id: slug,
                number: String(exists ? exists.number : String(highest + 1).padStart(3, "0")),
                name: job.name,
                category: job.category || "Software",
                summary: job.summary || job.description || "",
                url: `projects/${slug}/index.html`,
                liveUrl: "",
                repoUrl: "",
                status: "released",
                highlights: highList,
                technologies: techList
            };
            if (exists) {
                Object.assign(exists, entry);
            } else {
                projects.push(entry);
            }
            data.projects = projects;
            writeFileSync(pjPath, JSON.stringify(data, null, 2) + "\n");
            git(SITE_REPO, ["add", "projects.json"]);
        }
        if (git(SITE_REPO, ["diff", "--cached", "--quiet"]).code === 0) {
            throw new Error("nothing changed (same project content already on git)");
        }
        const commit = git(SITE_REPO, ["commit", "-m", `project ${slug}: ${job.title} (job ${job.id})`]);
        if (commit.code !== 0) {
            throw new Error(`git commit failed: ${commit.out.slice(0, 300)}`);
        }
        const push = git(SITE_REPO, ["push", "origin", branch, "--force-with-lease"]);
        if (push.code !== 0) {
            throw new Error(`git push failed: ${push.out.slice(0, 300)}`);
        }

        // fast-forward style merge to main (single-writer pipeline, all audited)
        git(SITE_REPO, ["checkout", "main"]);
        const merge = git(SITE_REPO, ["merge", "--no-ff", branch, "-m", `merge ${branch} (job ${job.id})`]);
        if (merge.code !== 0) {
            throw new Error(`merge to main failed (conflict?): ${merge.out.slice(0, 300)}`);
        }
        const pushMain = git(SITE_REPO, ["push", "origin", "main"]);
        if (pushMain.code !== 0) {
            throw new Error(`push main failed: ${pushMain.out.slice(0, 300)}`);
        }
        await progress(job.id, step2, "done", branch);
        await progress(job.id, step3, "done", "merged to main");
        await progress(job.id, step4, "active", "deploying site");
        const deploy = npmWrangler(SITE_REPO, ["deploy"], { timeout: 300000 });
        if (deploy.code !== 0) {
            throw new Error(`site deploy failed: ${lastLines(deploy.out, 400)}`);
        }
        await progress(job.id, step4, "done", "ivorists.com updated");

        return {
            status: "done",
            urls: [`https://ivorists.com/projects/${slug}/index.html`],
            branch
        };
    }

    /* =====================================================
       SITE CHANGE (/change)
       ===================================================== */
    if (job.type === "change") {
        await progress(job.id, step1, "active", "scanning contents");
        const textFiles = files.filter((f) => TEXT_EXTENSIONS.includes(path.extname(f.rel).toLowerCase()));
        for (const file of textFiles) {
            const hits = rules.looksLikeSecretMatch(readTextSafe(file.abs));
            if (hits.length) {
                throw new Rejection(`${file.rel} looks like it contains a live credential (${hits[0]}). Rotate the key and resubmit.`);
            }
        }
        await progress(job.id, step1, "done", "contents clean");

        const branch = `changes/job-${job.id.replace(/[^a-z0-9-]/gi, "")}`;
        await progress(job.id, step2, "active", `branch ${branch}`);
        assertCleanRepo();
        git(SITE_REPO, ["fetch", "origin"]);
        git(SITE_REPO, ["checkout", "-B", branch, "origin/main"]);
        copyTreeTo(SITE_REPO, unpack, ".");
        git(SITE_REPO, ["add", "-A"]);
        if (git(SITE_REPO, ["diff", "--cached", "--quiet"]).code === 0) {
            const repoState = git(SITE_REPO, ["checkout", "main"]);
            void repoState;
            throw new Error("no file differences — the site already matches this change");
        }
        const commit = git(SITE_REPO, ["commit", "-m", `site change: ${job.title} (job ${job.id})`]);
        if (commit.code !== 0) {
            throw new Error(`git commit failed: ${commit.out.slice(0, 300)}`);
        }
        const push = git(SITE_REPO, ["push", "origin", branch, "--force-with-lease"]);
        if (push.code !== 0) {
            throw new Error(`git push failed: ${push.out.slice(0, 300)}`);
        }
        git(SITE_REPO, ["checkout", "main"]);
        const merge = git(SITE_REPO, ["merge", "--no-ff", branch, "-m", `merge ${branch} (job ${job.id})`]);
        if (merge.code !== 0) {
            throw new Error(`merge to main failed (conflict?): ${merge.out.slice(0, 300)}`);
        }
        const pushMain = git(SITE_REPO, ["push", "origin", "main"]);
        if (pushMain.code !== 0) {
            throw new Error(`push main failed: ${pushMain.out.slice(0, 300)}`);
        }
        await progress(job.id, step2, "done", branch);
        await progress(job.id, step3, "done", "merged to main");

        await progress(job.id, step4, "active", "deploying site");
        const deploy = npmWrangler(SITE_REPO, ["deploy"], { timeout: 300000 });
        if (deploy.code !== 0) {
            throw new Error(`site deploy failed: ${lastLines(deploy.out, 400)}`);
        }
        await progress(job.id, step4, "done", "ivorists.com updated");

        return {
            status: "done",
            urls: ["https://ivorists.com"],
            branch,
            merged: true
        };
    }

    throw new Error(`unknown job type ${job.type}`);
}

/* =========================================================
   helpers used by the pipelines
   ========================================================= */

let staticVars = {};

// Uses the local wrangler OAuth token (never stored in git) to manage the
// zone routing layer: the ivorists.com zone's wildcard route outranks
// custom domains, so each app subdomain gets its own explicit route.
function wranglerToken() {
    const candidates = [
        process.env.APPDATA + "\\xdg.config\\.wrangler\\config\\default.toml",
        process.env.HOME + "\\.config\\.wrangler\\config\\default.toml"
    ];
    for (const file of candidates) {
        try {
            if (existsSync(file)) {
                const raw = readFileSync(file, "utf8");
                const m = raw.match(/oauth_token\s*=\s*"?([^"\r\n]+)"?/);
                if (m) {
                    return m[1];
                }
            }
        } catch { /* next */ }
    }
    return null;
}

async function cloudflareApi(method, path, body) {
    const token = wranglerToken();
    if (!token) {
        return { ok: false, status: 0 };
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
        data = await res.json();
    } catch { /* ignore */ }
    return { ok: res.ok && data && data.success !== false, status: res.status, data };
}

async function ensureAppRoute(subdomain) {
    const zoneRes = await cloudflareApi("GET", "/zones?name=ivorists.com");
    const zone = zoneRes.ok && zoneRes.data && zoneRes.data.result && zoneRes.data.result[0];
    if (!zone) {
        return "zone lookup failed (route not forced)";
    }
    const routeRes = await cloudflareApi("POST", `/zones/${zone.id}/workers/routes`, {
        pattern: `${subdomain}.ivorists.com/*`,
        script: `ivorist-app-${subdomain}`
    });
    return routeRes.ok ? "route forced" : `route add failed: ${routeRes.status}`;
}

function hitsForbidden(rel) {
    const lower = rel.toLowerCase();
    return rules.SITE_FORBIDDEN_PATHS.some((prefix) => lower === prefix || lower.startsWith(prefix.replace(/\/+$/, "") + "/"));
}

function copyTree(src, dest, exclude) {
    mkdirSync(dest, { recursive: true });
    const skip = exclude ? new Set(exclude.map((p) => p.toLowerCase())) : null;
    for (const f of walk(src)) {
        const rel = f.rel.toLowerCase();
        if (skip && ([...skip].some((entry) => rel === entry || rel.startsWith(entry + "/")))) {
            continue;
        }
        const target = path.join(dest, f.rel);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(f.abs, target);
    }
}

function copyTreeTo(repo, src, relDir) {
    const dest = relDir === "." ? repo : path.join(repo, relDir);
    copyTree(src, dest);
}

function patchWorkerSignature(text) {
    let out = text;
    // property style: fetch: (request) => ...  or  fetch: async (request) => ...
    out = out.replace(/(fetch\s*:\s*(?:async\s*)?\(\s*)request(\s*\))/g, "$1request, env$2");
    // method style: fetch(request) {  or  async fetch(request) {
    out = out.replace(/(fetch\s*\(\s*)request(\s*\)\s*\{)/g, "$1request, env$2");
    return out;
}

function assertCleanRepo() {
    const status = git(SITE_REPO, ["status", "--porcelain"]);
    if (status.out.trim().length) {
        git(SITE_REPO, ["checkout", "main"]);
        throw new Rejection(`the ivorist repo has uncommitted local edits, refusing to branch on top of them:\n${status.out.slice(0, 400)}`);
    }
}

function lastLines(text, max) {
    const lines = String(text || "").trim().split(/\r?\n/);
    return lines.slice(-6).join(" | ").slice(0, max);
}

function writeDeployConfig(deployDir, subdomain, hasWorker, secretKeys, vars, countVars) {
    const config = {
        name: `ivorist-app-${subdomain}`,
        main: hasWorker ? "worker.js" : undefined,
        compatibility_date: "2025-05-01",
        workers_dev: true,
        assets: {
            directory: deployDir,
            binding: "ASSETS"
        },
        routes: [
            {
                pattern: `${subdomain}.ivorists.com`,
                custom_domain: true
            }
        ]
    };
    if (countVars) {
        const asVars = Object.fromEntries(Object.entries(vars || {}).map(([k, v]) => [k, v]));
        if (Object.keys(asVars).length) {
            config.vars = asVars;
        }
    }
    writeFileSync(path.join(deployDir, "wrangler.jsonc"), JSON.stringify(config, null, 2) + "\n");
    // never ship the deploy plumbing itself as public assets
    writeFileSync(path.join(deployDir, ".assetsignore"), "wrangler.jsonc\nworker.js\n.gitignore\n.wrangler\n.env\n");
}

function configWithoutCustomDomain(deployDir, subdomain) {
    const p = path.join(deployDir, "wrangler.jsonc");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    delete cfg.routes;
    cfg.workers_dev = true;
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

async function waitUntilOk(url) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.status < 500) {
                return true;
            }
        } catch { /* retry */ }
        await sleep(5000);
    }
    return false;
}

/* =========================================================
   main loop
   ========================================================= */

let lastBeat = 0;

async function claimOnce() {
    if (Date.now() - lastBeat > 55000) {
        lastBeat = Date.now();
        post("/runner/heartbeat", null).catch(() => null);
    }
    const res = await api("/runner/claim", { method: "POST" });
    if (!res.ok) {
        return null;
    }
    const data = await res.json();
    return data.job || null;
}

async function main() {
    console.log(`ivorist runner online — ${WORKER_BASE} · inbox ${INBOX}`);
    heartbeatLoop();
    for (;;) {
        let job = null;
        try {
            job = await claimOnce();
        } catch (error) {
            console.error("poll failed:", lastLines(String(error), 200));
            await sleep(7000);
            continue;
        }
        if (!job) {
            await sleep(5000);
            continue;
        }

        console.log(`job ${job.id} [${job.type}] ${job.title} claimed`);
        staticVars = {};
        try {
            const result = await runPipeline(job);
            await post("/runner/result", { jobId: job.id, ...result });
            console.log(`job ${job.id} done -> ${JSON.stringify(result.urls)}`);
        } catch (error) {
            const rejected = error && error.rejection;
            const payload = {
                jobId: job.id,
                status: rejected ? "rejected" : "failed",
                error: lastLines(`${rejected ? "REJECTED — " : ERROR_PREFIX()}${error.message || error}`, 900),
                urls: []
            };
            await post("/runner/result", payload).catch((e) => console.error("result post failed", e));
            console.error(`job ${job.id} ${payload.status}: ${payload.error}`);
        } finally {
            try {
                git(SITE_REPO, ["checkout", "main"]);
            } catch { /* Site repo reset */ }
        }
    }
}

function ERROR_PREFIX() {
    return "FAILED — ";
}

process.on("unhandledRejection", (error) => {
    console.error("unhandled:", String(error).slice(0, 300));
});

main();
