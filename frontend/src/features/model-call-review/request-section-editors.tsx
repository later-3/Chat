import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { isRecord } from "../../model-call-review-logic";
import type { ModelCapabilities, ParameterCapability } from "../../use-chat-agent";
import { FixedValueEditor, KeyLabel } from "./structured-editors";

export function ToolEditor({
  value,
  onChange,
  registeredToolNames,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  registeredToolNames: string[];
}) {
  const tools = Array.isArray(value) ? value : [];
  return (
    <div className="tool-selector">
      <label className="review-field review-field--wide">
        <span>服务端已绑定Tool</span>
        <select aria-label="选择可用Tool" disabled value="">
          <option value="">
            {registeredToolNames.length ? registeredToolNames.join("、") : "暂无已注册的可执行Tool"}
          </option>
        </select>
        <small>
          name与type绑定真实执行器，不能改名；说明、Schema等Value可修改，修改后仍会服务端校验。
        </small>
      </label>
      {!Array.isArray(value) && (
        <p className="review-error">tools不是有效列表，请到Provider JSON中修正。</p>
      )}
      {tools.map((tool, index) => {
        const record = isRecord(tool) ? tool : {};
        const nested = isRecord(record.function) ? record.function : record;
        const name = typeof nested.name === "string" ? nested.name : "";
        const registered = registeredToolNames.includes(name);
        const updateNested = (next: Record<string, unknown>) => {
          const nextTool = isRecord(record.function) ? { ...record, function: next } : next;
          onChange(tools.map((current, itemIndex) => (itemIndex === index ? nextTool : current)));
        };
        return (
          // Provider Tool arrays do not carry UI identities; index is the canonical request position.
          <article className="structured-card" key={`tool-${index}`}>
            <header>
              <div>
                <span className="item-index">
                  {registered ? "已绑定Tool" : "未绑定Tool"} {index + 1}
                </span>
                <small>
                  {name || "名称无效"} · {registered ? "name锁定" : "当前不能发送"}
                </small>
              </div>
              <button
                aria-label={`删除Tool${index + 1}`}
                className="structured-remove"
                onClick={() => onChange(tools.filter((_, itemIndex) => itemIndex !== index))}
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </header>
            {registered ? (
              <div className="structured-object">
                <div className="kv-row">
                  <KeyLabel name="name" />
                  <div className="kv-value">
                    <input disabled value={name} />
                  </div>
                </div>
                {Object.entries(nested)
                  .filter(([key]) => key !== "name")
                  .map(([key, child]) => (
                    <div className="kv-row" key={key}>
                      <KeyLabel name={key} />
                      <div className="kv-value">
                        <FixedValueEditor
                          fieldKey={key}
                          onChange={(next) => updateNested({ ...nested, [key]: next })}
                          value={child}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="tool-unbound-note">该定义没有对应的服务端执行器，请删除后再保存。</p>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function ParameterEditor({
  value,
  capabilities,
  onChange,
}: {
  value: Record<string, unknown>;
  capabilities: ModelCapabilities;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [parameterToAdd, setParameterToAdd] = useState("");
  const capabilityByKey = new Map(
    capabilities.parameters.map((parameter) => [parameter.key, parameter]),
  );
  const available = capabilities.parameters.filter((parameter) => !(parameter.key in value));
  return (
    <div className="parameter-editor">
      <div className="structured-object">
        {Object.entries(value).map(([key, child]) => {
          const capability = capabilityByKey.get(key);
          return (
            <div className="kv-row" key={key}>
              <KeyLabel name={key} />
              <div className="kv-value parameter-value">
                {capability ? (
                  <ParameterValueEditor
                    capability={capability}
                    onChange={(next) => onChange({ ...value, [key]: next })}
                    value={child}
                  />
                ) : (
                  <FixedValueEditor
                    fieldKey={key}
                    onChange={(next) => onChange({ ...value, [key]: next })}
                    value={child}
                  />
                )}
                {!capability && capabilities.allow_unknown_parameters && (
                  <small>Provider运行时参数；Key固定，Value仍可编辑并由发送前服务端校验。</small>
                )}
                {!capability && !capabilities.allow_unknown_parameters && (
                  <small className="field-error">当前模型没有声明该参数能力</small>
                )}
                {!capability?.locked && !["store", "stream"].includes(key) && (
                  <button
                    className="structured-remove"
                    onClick={() =>
                      onChange(
                        Object.fromEntries(
                          Object.entries(value).filter(([itemKey]) => itemKey !== key),
                        ),
                      )
                    }
                    type="button"
                  >
                    <Trash2 size={14} /> 移除参数
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {available.length > 0 && (
        <div className="parameter-add-row">
          <label>
            <span>添加常用参数</span>
            <select
              onChange={(event) => setParameterToAdd(event.target.value)}
              value={parameterToAdd}
            >
              <option value="">选择参数…</option>
              {available.map((parameter) => (
                <option key={parameter.key} value={parameter.key}>
                  {parameter.key} · {parameter.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="structured-add"
            disabled={!parameterToAdd}
            onClick={() => {
              if (!parameterToAdd) return;
              const capability = capabilityByKey.get(parameterToAdd);
              if (!capability) return;
              onChange({ ...value, [parameterToAdd]: capability.default });
              setParameterToAdd("");
            }}
            type="button"
          >
            <Plus size={15} /> 添加
          </button>
        </div>
      )}
    </div>
  );
}

function ParameterValueEditor({
  capability,
  value,
  onChange,
}: {
  capability: ParameterCapability;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (capability.value_type === "boolean") {
    return (
      <select
        disabled={capability.locked}
        onChange={(event) => onChange(event.target.value === "true")}
        value={String(value)}
      >
        <option value="false">否（false）</option>
        <option value="true">是（true）</option>
      </select>
    );
  }
  if (capability.value_type === "integer" || capability.value_type === "number") {
    return (
      <input
        max={capability.maximum ?? undefined}
        min={capability.minimum ?? undefined}
        onChange={(event) =>
          onChange(
            capability.value_type === "integer"
              ? Number.parseInt(event.target.value, 10)
              : Number(event.target.value),
          )
        }
        step={capability.value_type === "integer" ? 1 : "any"}
        type="number"
        value={typeof value === "number" ? value : ""}
      />
    );
  }
  if (capability.value_type === "enum") {
    return (
      <select onChange={(event) => onChange(event.target.value)} value={String(value)}>
        {capability.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  if (capability.value_type === "object_enum" && capability.child_key) {
    const record = isRecord(value) ? value : {};
    return (
      <label>
        <span>{capability.child_key}</span>
        <select
          onChange={(event) =>
            onChange({ ...record, [capability.child_key as string]: event.target.value })
          }
          value={String(record[capability.child_key] ?? "")}
        >
          {capability.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return <FixedValueEditor fieldKey={capability.key} onChange={onChange} value={value} />;
}
