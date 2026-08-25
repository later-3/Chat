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
  const supersededBy = /^- 替代者：ADR-(\d{4})$/mu.exec(source)?.[1];
  const supersedes = [...source.matchAll(/^- 替代：ADR-(\d{4})$/gmu)].map((entry) => entry[1]);
  if (status === "superseded" && supersededBy === undefined) {
    throw new Error(`${filename}为superseded但缺少替代者`);
  }
  if (status !== "superseded" && supersededBy !== undefined) {
    throw new Error(`${filename}非superseded却声明替代者`);
  }
  return { number, status, supersededBy, supersedes };
}

export function validateDecisionRelations(records) {
  const byNumber = new Map();
  for (const record of records) {
    if (byNumber.has(record.number)) throw new Error(`ADR编号重复：${record.number}`);
    byNumber.set(record.number, record);
  }
  for (const record of records) {
    if (record.supersededBy === record.number || record.supersedes.includes(record.number)) {
      throw new Error(`${record.filename}禁止自我替代`);
    }
    if (new Set(record.supersedes).size !== record.supersedes.length) {
      throw new Error(`${record.filename}替代关系列表重复`);
    }
    if (record.supersededBy !== undefined) {
      const successor = byNumber.get(record.supersededBy);
      if (successor === undefined) throw new Error(`${record.filename}替代者不存在`);
      if (!successor.supersedes.includes(record.number)) {
        throw new Error(`${successor.filename}未反向记录替代ADR-${record.number}`);
      }
    }
    for (const previous of record.supersedes) {
      const predecessor = byNumber.get(previous);
      if (predecessor === undefined)
        throw new Error(`${record.filename}替代的ADR-${previous}不存在`);
      if (predecessor.supersededBy !== record.number) {
        throw new Error(`${predecessor.filename}未记录替代者ADR-${record.number}`);
      }
    }
  }
  for (const record of records) {
    const path = new Set([record.number]);
    let current = record;
    while (current.supersededBy !== undefined) {
      if (path.has(current.supersededBy)) {
        throw new Error(`${record.filename}替代关系形成环`);
      }
      path.add(current.supersededBy);
      current = byNumber.get(current.supersededBy);
    }
  }
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
  validateDecisionRelations(records);
  validateDecisionIndex(readFileSync(resolve(DECISIONS, "README.md"), "utf8"), records);
  if (!existsSync(resolve(DECISIONS, "template.md"))) throw new Error("ADR模板缺失");
  return records;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const records = checkDecisionRecords();
  console.log(`ADR索引有效：${String(records.length)}条`);
}
