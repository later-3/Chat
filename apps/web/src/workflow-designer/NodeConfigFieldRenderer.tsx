import type { WorkflowCatalogDto } from "@chat/contracts/public";
import { useEffect, useState } from "react";

type PublicField = WorkflowCatalogDto["nodes"][number]["publicConfigFields"][number];
type BoundedIntegerField = Extract<PublicField, { type: "bounded_integer" }>;
type TagListField = Extract<PublicField, { type: "tag_list" }>;

function BoundedIntegerInput({
  field,
  value,
  disabled,
  inputId,
  onChange,
}: {
  readonly field: BoundedIntegerField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly inputId: string;
  readonly onChange: (value: unknown) => void;
}) {
  const numericValue = typeof value === "number" ? value : field.defaultValue;
  const [draft, setDraft] = useState(String(numericValue));
  useEffect(() => setDraft(String(numericValue)), [numericValue]);
  return (
    <label className="designer-field" htmlFor={inputId}>
      <span>{field.label}</span>
      <input
        id={inputId}
        aria-label={field.label}
        type="number"
        min={field.minimum}
        max={field.maximum}
        step={1}
        value={draft}
        disabled={disabled}
        onBlur={() => {
          if (draft === "") setDraft(String(numericValue));
        }}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          // 清空 number input 会短暂产生 NaN；它不能进入语义 Working Copy，
          // 否则本地 JSON 会丢失该字段且可能绕过服务端的整数边界校验。
          if (nextDraft !== "" && Number.isFinite(event.target.valueAsNumber)) {
            onChange(event.target.valueAsNumber);
          }
        }}
      />
      <small>
        允许 {field.minimum}–{field.maximum}
      </small>
    </label>
  );
}

function TagListInput({
  field,
  value,
  disabled,
  inputId,
  onChange,
}: {
  readonly field: TagListField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly inputId: string;
  readonly onChange: (value: unknown) => void;
}) {
  const tags = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const serializedTags = tags.join("、");
  const [draft, setDraft] = useState(serializedTags);
  useEffect(() => setDraft(serializedTags), [serializedTags]);
  return (
    <label className="designer-field" htmlFor={inputId}>
      <span>{field.label}</span>
      <input
        id={inputId}
        aria-label={field.label}
        type="text"
        value={draft}
        disabled={disabled}
        placeholder="用逗号或顿号分隔"
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          onChange(
            nextDraft
              .split(/[,，、]/u)
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, field.maxItems),
          );
        }}
      />
      <small>
        最多 {field.maxItems} 个，每个最多 {field.maxLabelLength} 字符
      </small>
    </label>
  );
}

export function isSupportedDesignerField(field: unknown): field is PublicField {
  if (typeof field !== "object" || field === null || !("type" in field)) return false;
  return [
    "boolean",
    "enum_select",
    "review_mode",
    "bounded_integer",
    "short_text",
    "tag_list",
    "resource_selector",
    "rule_selector",
    "skill_selector",
    "note_source_selector",
  ].includes(String((field as { type: unknown }).type));
}

export function NodeConfigFieldRenderer({
  field,
  value,
  disabled,
  inputId,
  onChange,
}: {
  readonly field: PublicField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly inputId: string;
  readonly onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="designer-field designer-field-checkbox" htmlFor={inputId}>
        <input
          id={inputId}
          aria-label={field.label}
          type="checkbox"
          checked={typeof value === "boolean" ? value : field.defaultValue}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === "enum_select" || field.type === "review_mode") {
    return (
      <label className="designer-field" htmlFor={inputId}>
        <span>{field.label}</span>
        <select
          id={inputId}
          aria-label={field.label}
          value={typeof value === "string" ? value : field.defaultValue}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "bounded_integer") {
    return (
      <BoundedIntegerInput
        field={field}
        value={value}
        disabled={disabled}
        inputId={inputId}
        onChange={onChange}
      />
    );
  }
  if (field.type === "short_text") {
    return (
      <label className="designer-field" htmlFor={inputId}>
        <span>{field.label}</span>
        <input
          id={inputId}
          aria-label={field.label}
          type="text"
          maxLength={field.maximumLength}
          value={typeof value === "string" ? value : field.defaultValue}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  if (field.type === "tag_list") {
    return (
      <TagListInput
        field={field}
        value={value}
        disabled={disabled}
        inputId={inputId}
        onChange={onChange}
      />
    );
  }
  if (
    field.type === "resource_selector" ||
    field.type === "rule_selector" ||
    field.type === "skill_selector" ||
    field.type === "note_source_selector"
  ) {
    const kind =
      field.type === "resource_selector"
        ? "资源"
        : field.type === "rule_selector"
          ? "规则"
          : field.type === "skill_selector"
            ? "Skill"
            : "笔记来源";
    return (
      <div className="designer-field designer-runtime-selector" id={inputId} role="note">
        <strong>{field.label}</strong>
        <span>
          {kind}在发起 Run 时按权限和版本选择；Definition 只保存此选择能力，不保存本次资源。
        </span>
        <small>
          {field.multiple ? "可多选" : "单选"} · {field.required ? "必须选择" : "可选"}
        </small>
      </div>
    );
  }
  return (
    <p className="designer-blocker" role="alert">
      当前客户端不支持此配置字段，已切换为只读；请升级后再编辑或发布。
    </p>
  );
}
