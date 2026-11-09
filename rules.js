/* =========================================================
   IVORIST TOOLCHAIN - shared rules (worker + runner import this)
   ========================================================= */

// Subdomains that belong to infra or are unsafe to hand out.
export const RESERVED_SUBDOMAINS = [
    "www", "api", "mail", "smtp", "bot", "team", "admin", "support",
    "dashboard", "cloudflare", "workers", "dev", "staging", "test",
    "app", "apps", "cdn", "static", "assets", "images", "files",
    "gateway", "runner", "ivorist", "ivorists"
];

export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

// Hard deny: anything executable or server-side that is not a documented worker.js.
export const DENIED_EXTENSIONS = [
    ".exe", ".msi", ".scr", ".bat", ".cmd", ".com", ".ps1", ".psm1",
    ".vbs", ".vbe", ".wsf", ".sh", ".bash", ".zsh", ".jar", ".apk",
    ".msix", ".appx", ".dll", ".so", ".dylib", ".bin", ".elf",
    ".php", ".py", ".pyc", ".rb", ".pl", ".cgi", ".aspx", ".jsp", ".asp"
];

// Files that are infra-owned and may never be patched by submissions.
export const SITE_FORBIDDEN_PATHS = [
    "worker.js", "wrangler.jsonc", "wrangler.toml",
    ".assetsignore", ".gitignore", ".git", ".wrangler",
    "logo.png", "readme.md", ".github"
];

export const SITE_ALLOWED_EXTENSIONS = [
    ".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg",
    ".jpeg", ".webp", ".gif", ".ico", ".avif", ".woff", ".woff2",
    ".ttf", ".otf", ".txt", ".md", ".xml", ".csv", ".map"
];

export const WEBAPP_ALLOWED_EXTENSIONS = [
    ...SITE_ALLOWED_EXTENSIONS, ".webmanifest", ".webp", ".mp3", ".mp4",
    ".wav", ".ogg", ".jsonc", ".yml"
];

// A site submission may carry multiple layers (html/css/etc), keep caps sane.
export const LIMITS = {
    maxZipBytes: 30 * 1024 * 1024,
    maxFileCount: 800,
    maxErrorChars: 900
};

// Patterns that indicate a credential. `severity: "high"` ones can never be
// safely embedded in a static app, so a static-only app gets rejected on match.
export const SECRET_PATTERNS = [
    { id: "GITHUB_PAT", severity: "high", re: /gh[pousr]_[A-Za-z0-9]{30,60}/ },
    { id: "SLACK_TOKEN", severity: "high", re: /xox[baprs]-[A-Za-z0-9-]{10,60}/ },
    { id: "OPENAI_KEY", severity: "high", re: /sk-[A-Za-z0-9-]{32,60}/ },
    { id: "SENDGRID_KEY", severity: "high", re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/ },
    { id: "AWS_ACCESS_KEY", severity: "high", re: /AKIA[0-9A-Z]{16}/ }
];

// Keys in .env whose VALUE should be extracted into a worker secret env var.
// HIGH keys in a static-only app trigger rejection.
export const DANGEROUS_ENV_KEYS = [
    { key: "AWS_ACCESS_KEY_ID", severity: "high" },
    { key: "AWS_SECRET_ACCESS_KEY", severity: "high" },
    { key: "AWS_SESSION_TOKEN", severity: "high" },
    { key: "OPENAI_API_KEY", severity: "high" },
    { key: "STRIPE_SECRET_KEY", severity: "high" },
    { key: "SENDGRID_API_KEY", severity: "high" },
    { key: "DISCORD_TOKEN", severity: "high" },
    { key: "GITHUB_TOKEN", severity: "high" },
    { key: "DATABASE_URL", severity: "med" },
    { key: "JWT_SECRET", severity: "med" },
    { key: "NPM_TOKEN", severity: "high" },
    { key: "SMTP_PASSWORD", severity: "high" },
    { key: "MAIL_PASSWORD", severity: "med" },
    { key: "TWILIO_AUTH_TOKEN", severity: "high" }
];

export function looksLikeSecretMatch(text) {
    const hits = [];
    for (const p of SECRET_PATTERNS) {
        if (p.re.test(text)) {
            hits.push(p.id);
        }
    }
    return hits;
}

export function isDeniedExtension(name) {
    const lower = name.toLowerCase();
    return DENIED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function slugChecks(value) {
    const subdomain = String(value || "").trim().toLowerCase();
    if (!SUBDOMAIN_RE.test(subdomain)) {
        return { ok: false, reason: "subdomain must be 3-32 chars: lowercase letters, numbers, hyphens; must start and end with a letter or number" };
    }
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
        return { ok: false, reason: `subdomain "${subdomain}" is reserved` };
    }
    return { ok: true, subdomain };
}

// Status pipeline shown in the live embed, per job type.
export const PIPELINES = {
    app: [
        "Validate zip & rules",
        "Secret scan & env rewrite",
        "Git branch & push",
        "Deploy worker",
        "Verify URL"
    ],
    project: [
        "Validate zip & rules",
        "Secret scan",
        "Git branch & push",
        "Merge to main",
        "Deploy site"
    ],
    change: [
        "Validate files & rules",
        "Secret scan",
        "Git commit & push",
        "Deploy site"
    ]
};

export function pipelineFor(type) {
    return PIPELINES[type] || [];
}
