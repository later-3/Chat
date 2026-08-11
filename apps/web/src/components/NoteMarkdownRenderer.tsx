import Markdown, { type Components } from "react-markdown";

const ALLOWED_ELEMENTS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "hr",
  "br",
  "a",
] as const;

function externalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

const COMPONENTS: Components = {
  // 链接不继承页面权限，也不允许opener反向操作当前Chat窗口。
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = href === undefined ? undefined : externalUrl(href);
    if (safeHref === undefined) {
      return (
        <span className="note-link-blocked">
          {children}
          <small>（链接已阻止）</small>
        </span>
      );
    }
    return (
      <span className="note-external-link">
        <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
        <small aria-label="外部链接提示">（外部链接）</small>
      </span>
    );
  },
};

export default function NoteMarkdownRenderer({ value }: { readonly value: string }) {
  return (
    <div className="note-markdown-rendered">
      <Markdown
        skipHtml
        allowedElements={[...ALLOWED_ELEMENTS]}
        components={COMPONENTS}
        urlTransform={(url) => externalUrl(url)}
      >
        {value}
      </Markdown>
    </div>
  );
}
