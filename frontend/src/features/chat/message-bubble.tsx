import type { Message } from "@ag-ui/core";
import { Sparkles, UserRound } from "lucide-react";

export function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const text = getMessageText(message);
  if (!text || !["user", "assistant"].includes(message.role)) return null;

  return (
    <article className={`message-row ${isUser ? "message-row--user" : ""}`}>
      <div className={`avatar ${isUser ? "avatar--user" : "avatar--assistant"}`}>
        {isUser ? <UserRound size={16} /> : <Sparkles size={16} />}
      </div>
      <div className={`message ${isUser ? "message--user" : "message--assistant"}`}>
        <p>{text}</p>
      </div>
    </article>
  );
}
