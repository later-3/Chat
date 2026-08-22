import type { AgentRuntimeBaselineDto } from "@chat/contracts/public";

type RuntimeResourceInventoryValue = NonNullable<
  AgentRuntimeBaselineDto["variants"][number]["resourceInventory"]
>;

const RESOURCE_INVENTORY_LABEL: Readonly<Record<keyof RuntimeResourceInventoryValue, string>> = {
  extensions: "Extensions",
  skills: "Skills",
  promptTemplates: "Prompt Templates",
  contextFiles: "Context Files",
};

const RESOURCE_INVENTORY_ORDER = [
  "extensions",
  "skills",
  "promptTemplates",
  "contextFiles",
] as const satisfies readonly (keyof RuntimeResourceInventoryValue)[];

/**
 * 只投影Pi Runtime已经解析出的portable资源事实。当前写合同只支持按类别继承或禁用，
 * 因此这里不制造逐项checkbox，避免界面承诺Runtime尚未消费的选择语义。
 */
export function RuntimeResourceInventory({
  inventory,
}: {
  inventory: RuntimeResourceInventoryValue | undefined;
}) {
  return (
    <section
      className="lifeos-agent-resource-inventory"
      data-testid="lifeos-agent-resource-inventory"
    >
      <header>
        <strong>Runtime 资源清单</strong>
        <span>portable ID / 路径</span>
      </header>
      <p>本版按类别启停，逐项选择尚未接入。</p>
      <div>
        {RESOURCE_INVENTORY_ORDER.map((resource) => {
          const entries = inventory?.[resource] ?? [];
          return (
            <article key={resource} data-resource-kind={resource}>
              <header>
                <strong>{RESOURCE_INVENTORY_LABEL[resource]}</strong>
                <span>{entries.length} 项</span>
              </header>
              {entries.length === 0 ? (
                <small>当前作用域未发现</small>
              ) : (
                <ul>
                  {entries.map((entry) => (
                    <li key={entry}>
                      <code title={entry}>{entry}</code>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
