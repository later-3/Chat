import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

/** 主题创建 Agent：只调用受控提交动作，不重写已批准内容。 */
export const TOPIC_CREATOR_AGENT = parseWorkflowAgentDefinition(config);
