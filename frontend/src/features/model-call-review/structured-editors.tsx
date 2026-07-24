import { Trash2 } from "lucide-react";

import { contentTypesForRole, isRecord } from "../../model-call-review-logic";
import type { ModelCapabilities } from "../../use-chat-agent";

const ENUM_VALUES: Record<string, string[]> = {
  effort: ["minimal", "low", "medium", "high", "xhigh"],
  verbosity: ["low", "medium", "high"],
  tool_choice: ["none", "auto", "required"],
};
const LONG_TEXT_KEYS = new Set(["text", "description", "instructions", "image_url"]);
const KEY_LABELS: Record<string, string> = {
  role: "消息角色",
  content: "消息内容",
  type: "内容类型",
  text: "文字",
  name: "名称",
  description: "说明",
  parameters: "参数结构",
  properties: "字段",
  required: "必填字段",
  additionalProperties: "允许额外字段",
  store: "Provider保存响应",
  stream: "流式返回",
  tool_choice: "工具选择方式",
  reasoning: "推理配置",
  effort: "推理强度",
  verbosity: "输出详略",
  max_output_tokens: "最大输出Token",
  temperature: "随机性",
  top_p: "采样范围",
  parallel_tool_calls: "并行工具调用",
};

export function KeyLabel({ name }: { name: string }) {
  return (
    <span className="kv-key">
      <code>{name}</code>
      {KEY_LABELS[name] && <small>{KEY_LABELS[name]}</small>}
    </span>
  );
}

function ScalarEditor({
  fieldKey,
  value,
  onChange,
}: {
  fieldKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (typeof value === "boolean") {
    return (
      <select
        aria-label={`${fieldKey} 的值`}
        onChange={(event) => onChange(event.target.value === "true")}
        value={String(value)}
      >
        <option value="false">否（false）</option>
        <option value="true">是（true）</option>
      </select>
    );
  }
  if (typeof value === "number") {
    return (
      <input
        aria-label={`${fieldKey} 的值`}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        step="any"
        type="number"
        value={value}
      />
    );
  }

  const text = value === null || value === undefined ? "" : String(value);
  const choices = ENUM_VALUES[fieldKey];
  if (choices) {
    const options = choices.includes(text) || !text ? choices : [text, ...choices];
    return (
      <select
        aria-label={`${fieldKey} 的值`}
        onChange={(event) => onChange(event.target.value)}
        value={text}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (LONG_TEXT_KEYS.has(fieldKey) || text.length > 90) {
    return (
      <textarea
        aria-label={`${fieldKey} 的值`}
        onChange={(event) => onChange(event.target.value)}
        rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))}
        value={text}
      />
    );
  }
  return (
    <input
      aria-label={`${fieldKey} 的值`}
      onChange={(event) => onChange(event.target.value)}
      value={text}
    />
  );
}

export function FixedValueEditor({
  fieldKey,
  value,
  onChange,
}: {
  fieldKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <div className="structured-array">
        {value.length === 0 && <p className="structured-empty">空列表</p>}
        {value.map((item, index) => (
          <div className="structured-array-item" key={`${fieldKey}-${index}`}>
            <div className="structured-item-heading">
              <span>项目 {index + 1}</span>
              <button
                aria-label={`删除${fieldKey}项目${index + 1}`}
                className="structured-remove"
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                type="button"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <FixedValueEditor
              fieldKey={fieldKey === "content" ? "content_item" : "item"}
              onChange={(next) =>
                onChange(value.map((current, itemIndex) => (itemIndex === index ? next : current)))
              }
              value={item}
            />
          </div>
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      <div className="structured-object">
        {entries.length === 0 && (
          <p className="structured-empty">空对象；新增字段请使用Provider JSON高级视图</p>
        )}
        {entries.map(([key, child]) => (
          <div className="kv-row" key={key}>
            <KeyLabel name={key} />
            <div className="kv-value">
              <FixedValueEditor
                fieldKey={key}
                onChange={(next) => onChange({ ...value, [key]: next })}
                value={child}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <ScalarEditor fieldKey={fieldKey} onChange={onChange} value={value} />;
}

export function ContentPartEditor({
  value,
  role,
  capabilities,
  onChange,
}: {
  value: unknown;
  role: string;
  capabilities: ModelCapabilities;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const part = isRecord(value) ? value : {};
  const allowedTypes = contentTypesForRole(capabilities, role);
  const type = typeof part.type === "string" ? part.type : (allowedTypes[0] ?? "input_text");
  const imageType = type === "input_image" || type === "image_url";
  const imageValue = isRecord(part.image_url) ? part.image_url.url : part.image_url;
  return (
    <div className="structured-object">
      <div className="kv-row">
        <KeyLabel name="type" />
        <div className="kv-value">
          <select
            aria-label="内容类型"
            onChange={(event) => {
              const nextType = event.target.value;
              onChange(
                nextType === "input_image" || nextType === "image_url"
                  ? {
                      type: nextType,
                      image_url:
                        nextType === "image_url"
                          ? { url: typeof imageValue === "string" ? imageValue : "" }
                          : typeof imageValue === "string"
                            ? imageValue
                            : "",
                    }
                  : { type: nextType, text: typeof part.text === "string" ? part.text : "" },
              );
            }}
            value={allowedTypes.includes(type) ? type : ""}
          >
            {!allowedTypes.includes(type) && <option value="">请选择兼容类型</option>}
            {allowedTypes.map((contentType) => (
              <option key={contentType} value={contentType}>
                {contentType}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="kv-row">
        <KeyLabel name={imageType ? "image_url" : "text"} />
        <div className="kv-value">
          <textarea
            aria-label={imageType ? "图片地址" : "文字"}
            onChange={(event) =>
              onChange({
                ...part,
                [imageType ? "image_url" : "text"]:
                  type === "image_url" ? { url: event.target.value } : event.target.value,
              })
            }
            rows={imageType ? 2 : 4}
            value={String(imageType ? (imageValue ?? "") : (part.text ?? ""))}
          />
        </div>
      </div>
    </div>
  );
}
