#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_ID = /^root_[A-Za-z0-9]+$/u;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

export function computeGitIdentityPin(rootPath) {
  if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath) {
    throw new Error("project_root_path_not_canonical");
  }
  const root = realpathSync(rootPath);
  if (root !== rootPath || !statSync(root).isDirectory()) {
    throw new Error("project_root_path_not_canonical");
  }
  const topLevel = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
  const commonDirectory = realpathSync(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const gitDirectory = realpathSync(
    git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]),
  );
  const rootRelativePath = relative(topLevel, root);
  if (
    rootRelativePath === ".." ||
    rootRelativePath.startsWith(`..${sep}`) ||
    resolve(topLevel, rootRelativePath) !== root
  ) {
    throw new Error("project_root_outside_git_repository");
  }
  return createHash("sha256")
    .update(
      [
        "chat-project-git-identity.v1",
        topLevel,
        commonDirectory,
        gitDirectory,
        rootRelativePath,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

export function pinsForArguments(args) {
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new Error(
      "usage: pnpm --silent project:git-identity-pin -- <rootId> <canonicalPath> [...]",
    );
  }
  const pins = {};
  for (let index = 0; index < args.length; index += 2) {
    const rootId = args[index];
    const rootPath = args[index + 1];
    if (!ROOT_ID.test(rootId) || Object.hasOwn(pins, rootId)) {
      throw new Error("project_root_id_invalid_or_duplicate");
    }
    pins[rootId] = computeGitIdentityPin(rootPath);
  }
  return pins;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rawArguments = process.argv.slice(2);
    const arguments_ = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
    const pins = pinsForArguments(arguments_);
    process.stdout.write(`CHAT_PROJECT_GIT_IDENTITY_PINS_JSON='${JSON.stringify(pins)}'\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "project_git_identity_pin_failed");
  }
}
