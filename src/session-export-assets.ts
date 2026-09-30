import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useStorage } from "nitro/storage";

/** Only shipped native Pi assets. No user-selected path or second HTML renderer. */
export async function materializeSessionExportAssets(directory: string) {
  const templates = ["template.html", "template.css", "template.js", "vendor/marked.min.js", "vendor/highlight.min.js"];
  await Promise.all([...templates.map(name => ({ name, source: `core/export-html/${name}`, store: "pi-export" })),
    { name: "dark.json", source: "modes/interactive/theme/dark.json", store: "pi-export-theme" }].map(async asset => {
    let content: string;
    try { content = await readFile(new URL(`../pi/packages/coding-agent/src/${asset.source}`, import.meta.url), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const raw: unknown = await useStorage(`assets:${asset.store}`).getItemRaw(asset.name);
      if (typeof raw === "string") content = raw;
      else if (raw instanceof Uint8Array) content = Buffer.from(raw).toString("utf8");
      else throw new Error(`缺少Pi导出资源: ${asset.source}`);
    }
    const target = join(directory, asset.name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  }));
  return { templateDir: directory, themeFile: join(directory, "dark.json") };
}
