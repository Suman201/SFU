#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { serverOrigin } = require("../apps/desktop/src/policy.cjs");

const commands = new Set(["dev", "build", "package:mac", "package:win"]);
const options = {
  "--server-url": "SFU_DESKTOP_SERVER_URL",
  "--website-url": "SFU_DESKTOP_WEBSITE_URL",
  "--update-url": "SFU_DESKTOP_UPDATE_URL",
};
const help = `Sapiovian Classroom desktop

Commands:
  npm run desktop:dev          Build and run; uses your existing backend
  npm run desktop:build        Build an unpacked app for this computer
  npm run desktop:package:mac  Build Mac DMG and ZIP installers
  npm run desktop:package:win  Build Windows NSIS installers

Optional arguments (after -- when using npm):
  --server-url URL   Existing backend origin; required for installer packaging
  --website-url URL  Website origin if different from the backend
  --update-url URL   HTTPS electron-updater feed
  --help            Show this help without building

Environment variables SFU_DESKTOP_SERVER_URL, SFU_DESKTOP_WEBSITE_URL, and
SFU_DESKTOP_UPDATE_URL are also supported. Arguments override environment values.
Dev and unpacked builds default to local backend http://127.0.0.1:3000 and
website http://localhost:4200. Start your existing backend separately.

Example:
  npm run desktop:package:win -- --server-url https://api.school.example --website-url https://school.example
`;

function parseOptions(argv, inherited = {}) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...args] = argv;
  if (!commands.has(command))
    throw new Error(
      "Choose dev, build, package:mac, or package:win. Use --help for examples.",
    );
  const environment = { ...inherited };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (!options[flag])
      throw new Error(
        `Unknown argument: ${flag}. Use --help for supported arguments.`,
      );
    if (seen.has(flag)) throw new Error(`Specify ${flag} only once.`);
    seen.add(flag);
    const value =
      separator >= 0 ? argument.slice(separator + 1) : args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a URL.`);
    environment[options[flag]] = value;
  }
  if (command.startsWith("package:") && !environment.SFU_DESKTOP_SERVER_URL) {
    throw new Error(
      "Installer packaging requires --server-url or SFU_DESKTOP_SERVER_URL. Use your institution backend origin.",
    );
  }
  const localDefault = !environment.SFU_DESKTOP_SERVER_URL;
  if (localDefault) {
    environment.SFU_DESKTOP_SERVER_URL = "http://127.0.0.1:3000";
    environment.SFU_DESKTOP_WEBSITE_URL ||= "http://localhost:4200";
  }
  environment.SFU_DESKTOP_SERVER_URL = serverOrigin(
    environment.SFU_DESKTOP_SERVER_URL,
  );
  if (environment.SFU_DESKTOP_WEBSITE_URL)
    environment.SFU_DESKTOP_WEBSITE_URL = serverOrigin(
      environment.SFU_DESKTOP_WEBSITE_URL,
    );
  if (environment.SFU_DESKTOP_UPDATE_URL) {
    const url = new URL(environment.SFU_DESKTOP_UPDATE_URL);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("The update feed must use HTTPS without credentials.");
    environment.SFU_DESKTOP_UPDATE_URL = url.href;
  }
  return { command, environment, localDefault };
}

function commandPlan(command) {
  if (!commands.has(command)) throw new Error("Unsupported desktop command.");
  if (command === "dev")
    return [
      ["run", "build:frontend", "-w", "@native-sfu/desktop"],
      ["run", "prepare:assets", "-w", "@native-sfu/desktop"],
      ["run", "start", "-w", "@native-sfu/desktop"],
    ];
  // Workspace build/package commands own their Angular build so direct workspace
  // invocation and clean root workspace builds are safe as well.
  return [["run", command, "-w", "@native-sfu/desktop"]];
}

async function main(argv) {
  const parsed = parseOptions(argv, process.env);
  if (parsed.help) return console.log(help);
  const { command, environment, localDefault } = parsed;
  if (localDefault)
    console.log(
      "Using the existing local backend at http://127.0.0.1:3000. Start it separately or use --server-url.",
    );
  const repo = path.resolve(__dirname, "..");
  let child;
  const stop = (signal) => child?.kill(signal);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  function runNpm(args) {
    // Executing npm's JS entrypoint avoids cmd.exe quoting and .cmd handling on Windows.
    const candidates = [
      process.env.npm_execpath,
      path.join(
        path.dirname(process.execPath),
        "node_modules/npm/bin/npm-cli.js",
      ),
      path.resolve(
        path.dirname(process.execPath),
        "../lib/node_modules/npm/bin/npm-cli.js",
      ),
    ].filter(Boolean);
    const cli = candidates.find((file) => fs.existsSync(file));
    if (!cli)
      throw new Error(
        "npm was not found. Run through npm run desktop:dev or install Node.js with npm.",
      );
    return new Promise((resolve, reject) => {
      child = spawn(process.execPath, [cli, ...args], {
        cwd: repo,
        env: environment,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              signal
                ? `Desktop command interrupted (${signal}).`
                : `Desktop command failed (${code}).`,
            ),
          );
      });
    });
  }

  try {
    for (const args of commandPlan(command)) await runNpm(args);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

module.exports = { parseOptions, commandPlan };
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
