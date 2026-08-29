import { createError, defineEventHandler, readBody } from "nitro/h3";
import { runNpx } from "../../../resources/npx.js";

const ANSI = /\x1B\[[0-9;]*m/g;
const SEARCH_API = process.env.SKILLS_API_URL ?? "https://skills.sh";

function formatInstalls(count: number | undefined): string {
  if (count === undefined || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseCliResults(output: string) {
  const clean = output.replace(ANSI, "").split("\n");
  const results: Array<{ package: string; installs: string; url: string }> = [];
  for (let index = 0; index < clean.length; index += 1) {
    const match = clean[index]?.trim().match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
    if (match === null || match === undefined) continue;
    const url = clean[index + 1]?.trim().replace(/^└\s*/, "") ?? "";
    results.push({
      package: match[1] as string,
      installs: match[2] as string,
      url: url.startsWith("https://") ? url : "",
    });
  }
  return results;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  const query = typeof body === "object" && body !== null && "query" in body ? body.query : undefined;
  if (typeof query !== "string" || query.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "query必须是非空字符串" });
  }
  try {
    const response = await fetch(`${SEARCH_API}/api/search?q=${encodeURIComponent(query.trim())}&limit=50`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      skills?: Array<{ id?: string; name?: string; source?: string; installs?: number }>;
    };
    return {
      results: (data.skills ?? []).flatMap((skill) => {
        if (!skill.name || (!skill.source && !skill.id)) return [];
        return [{
          package: `${skill.source ?? skill.id}@${skill.name}`,
          installs: formatInstalls(skill.installs),
          url: skill.id ? `${SEARCH_API}/${skill.id}` : "",
        }];
      }),
    };
  } catch {
    try {
      const result = await runNpx(["skills", "find", query.trim()], {
        timeoutMs: 20_000,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      return { results: parseCliResults(`${result.stdout}${result.stderr}`) };
    } catch (error) {
      throw createError({ statusCode: 502, statusMessage: error instanceof Error ? error.message : String(error) });
    }
  }
});
