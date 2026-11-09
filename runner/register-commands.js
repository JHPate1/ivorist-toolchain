/* Register the Ivorist Ops slash commands on the guild.
   Usage: node register-commands.js
   Needs DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID in
   the environment (or in runner-config.json under the same names). */

import { readFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(process.argv[1]);
let config = {};
try {
    config = JSON.parse(readFileSync(path.join(here, "runner-config.json"), "utf8"));
} catch { /* env only */ }

const TOKEN = process.env.DISCORD_TOKEN || config.discordToken;
const APP_ID = process.env.DISCORD_APPLICATION_ID || config.discordApplicationId;
const GUILD_ID = process.env.DISCORD_GUILD_ID || config.discordGuildId;

if (!TOKEN || !APP_ID) {
    console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required (env or runner-config.json).");
    process.exit(1);
}

const at = new URL(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`);
const base = !GUILD_ID ? new URL(`https://discord.com/api/v10/applications/${APP_ID}/commands`) : at;

const COMMANDS = [
    {
        name: "create",
        description: "Deploy a web app on ivorists.com (strict rules apply).",
        options: [
            { type: 3, name: "subdomain", description: "Your subdomain, e.g. my-tool (becomes https://my-tool.ivorists.com)", required: true },
            { type: 3, name: "name", description: "Project name", required: true },
            { type: 11, name: "zip", description: "Zip with the app (index.html at root, optional worker.js + .env)", required: true },
            { type: 3, name: "description", description: "What the app does", required: false }
        ]
    },
    {
        name: "project",
        description: "Submit a project to ivorists.com (own page, listed in projects.json).",
        options: [
            { type: 3, name: "name", description: "Project name", required: true },
            { type: 3, name: "summary", description: "One-line summary used on the site", required: true },
            { type: 11, name: "zip", description: "Zip with the project page (index.html at zip root)", required: true },
            { type: 3, name: "category", description: "Category, e.g. Software / Hardware / Research", required: false },
            { type: 3, name: "description", description: "Longer walkthrough (goes on the tracker only)", required: false }
        ]
    },
    {
        name: "change",
        description: "Submit a change to the live site (html/css/js/json/images).",
        options: [
            { type: 3, name: "summary", description: "What changes and why", required: true },
            { type: 11, name: "zip", description: "Zip with the changed files (paths mirror the repo)", required: true }
        ]
    },
    {
        name: "bank",
        description: "Ivorist Bank (coming soon)."
    },
    {
        name: "apps",
        description: "List deployed web apps."
    },
    {
        name: "status",
        description: "Show the tracker embed for a job.",
        options: [
            { type: 3, name: "job_id", description: "Job id, e.g. j-a1b2c3-xyz (blank = latest)", required: false }
        ]
    },
    {
        name: "log",
        description: "Recent job log."
    },
    {
        name: "ping",
        description: "Check which parts of the toolchain are online."
    }
];

async function main() {
    const res = await fetch(base, {
        method: "PUT",
        headers: {
            "Authorization": `Bot ${TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(COMMANDS)
    });
    const body = await res.json();
    if (!res.ok) {
        console.error("register failed:", JSON.stringify(body, null, 2));
        process.exit(1);
    }
    console.log(`registered ${body.length} commands on ${GUILD_ID ? "guild " + GUILD_ID : "global scope"}`);
}

main();
