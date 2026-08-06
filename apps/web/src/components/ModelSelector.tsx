import type { ModelOption } from "../viewmodel/chat-view-model.js";

interface ModelSelectorProps {
  models: readonly ModelOption[];
  value: string;
  onChange: (modelId: string) => void;
}

/** 模型选择：P1.1使用本地fixture列表，仅作界面偏好，不触发任何Provider调用。 */
export function ModelSelector({ models, value, onChange }: ModelSelectorProps) {
  return (
    <select
      className="model-select"
      aria-label="选择模型"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </select>
  );
}
