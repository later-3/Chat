import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DECISIONS = resolve(ROOT, "docs/decisions");
const STATUS_PATTERN = /^- 状态：(proposed|accepted|superseded)$/mu;
const REQUIRED_SECTIONS = Object.freeze(["背景", "决定", "后果", "替代方案", "变更与回滚"]);

export function validateDecisionRecordSource(source, filename) {
  const match = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.exec(filename);
  if (match === null) throw new Error(`ADR文件名非法：${filename}`);
  const number = match[1];
  if (!source.startsWith(`# ADR-${number}: `)) throw new Error(`${filename}标题编号不一致`);
  const status = STATUS_PATTERN.exec(source)?.[1];
  if (status === undefined) throw new Error(`${filename}状态缺失或非法`);
  if (!/^- 日期：\d{4}-\d{2}-\d{2}$/mu.test(source)) throw new Error(`${filename}日期缺失`);
  if (!/^- 适用范围：.+$/mu.test(source)) throw new Error(`${filename}适用范围缺失`);
  if (!/^- 决策所有者：.+$/mu.test(source)) throw new Error(`${filename}决策所有者缺失`);
  for (const section of REQUIRED_SECTIONS) {
    if (!source.includes(`## ${section}`)) throw new Error(`${filename}缺少${section}章节`);
  }
  return { number, status };
}

export function validateDecisionIndex(indexSource, records) {
  for (const record of records) {
    const pattern = new RegExp(
      `\\| ${record.number} \\|[^\\n]+\\| ${record.status} \\| \\[ADR-${record.number}\\]\\(\\./${record.filename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\) \\|`,
      "u",
    );
    if (!pattern.test(indexSource)) throw new Error(`ADR索引缺失或状态漂移：${record.filename}`);
  }
  const indexed = [...indexSource.matchAll(/\[ADR-(\d{4})\]\(\.\/(\d{4}-[^)]+\.md)\)/gu)];
  if (indexed.length !== records.length) throw new Error("ADR索引包含缺失文件或重复记录");
}

export function checkDecisionRecords() {
  const files = readdirSync(DECISIONS)
    .filter((name) => /^\d{4}-.+\.md$/u.test(name))
    .sort();
  const records = files.map((filename) => ({
    filename,
    ...validateDecisionRecordSource(readFileSync(resolve(DECISIONS, filename), "utf8"), filename),
  }));
  validateDecisionIndex(readFileSync(resolve(DECISIONS, "README.md"), "utf8"), records);
  if (!existsSync(resolve(DECISIONS, "template.md"))) throw new Error("ADR模板缺失");
  return records;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const records = checkDecisionRecords();
  console.log(`ADR索引有效：${String(records.length)}条`);
}
