import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

/** 主题整理 Agent：只读搜集并产出审核草稿，自身没有创建权限。 */
export const TOPIC_COLLECTOR_AGENT = parseWorkflowAgentDefinition(config);
