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
        description: "Open the deploy form — files are attached in the channel afterwards."
    },
    {
        name: "project",
        description: "Open the project form — text alone builds the project page."
    },
    {
        name: "change",
        description: "Open the site-change form — attach files in the channel afterwards."
    },
    {
        name: "bank",
        description: "Open the Ivorist Bank request form (logged until launch)."
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
    },
    {
        name: "clear",
        description: "Clear all pending/active jobs or kill a specific job.",
        options: [
            { type: 3, name: "job_id", description: "Job id to kill immediately (blank = clear entire queue)", required: false }
        ]
    },
    {
        name: "kill",
        description: "Kill a running/pending job immediately without letting it finish.",
        options: [
            { type: 3, name: "job_id", description: "Job id to kill immediately (blank = current active job)", required: false }
        ]
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
