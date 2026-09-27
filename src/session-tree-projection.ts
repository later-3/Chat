import type { SessionManager } from "@earendil-works/pi-coding-agent";

type NativeTree = ReturnType<SessionManager["getTree"]>;
interface BranchPreview { readonly role?: "user" | "assistant"; readonly text: string }
interface NavigationNode {
  readonly entry: { readonly id: string; readonly parentId: string | null; readonly timestamp: string;
    readonly type: "custom"; readonly customType: "chat.branch-navigation" };
  readonly children: NavigationNode[];
  readonly label?: string;
  readonly compressedEntryIds: string[];
  readonly branchPreview?: BranchPreview;
}
function preview(node: NativeTree[number]): BranchPreview | undefined {
  const entry = node.entry;
  if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return undefined;
  const content = entry.message.content;
  const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join(" ");
  return { role: entry.message.role, text: text.replace(/\s+/g, " ").slice(0, 160) };
}

/** Navigation needs identities, branches and labels, never copies of tool results/images/assembly. */
export function projectNavigationTree(nodes: NativeTree): NavigationNode[] {
  return nodes.map(first => {
    let node = first;
    let branchPreview = preview(node);
    const compressedEntryIds: string[] = [];
    while (node.children.length === 1 && node.label === undefined) {
      compressedEntryIds.push(node.entry.id);
      node = node.children[0]!;
      branchPreview ??= preview(node);
    }
    const { id, parentId, timestamp } = node.entry;
    return { entry: { id, parentId, timestamp, type: "custom", customType: "chat.branch-navigation" },
      children: projectNavigationTree(node.children), compressedEntryIds,
      ...(node.label === undefined ? {} : { label: node.label }),
      ...(branchPreview === undefined ? {} : { branchPreview }) };
  });
}
