import { lazy, Suspense } from "react";

const NoteMarkdownRenderer = lazy(() => import("./NoteMarkdownRenderer.js"));

/** Note Markdown解析器独立成lazy chunk；Product API仍只拥有源码，浏览器不保存派生HTML。 */
export function NoteMarkdown({
  value,
  label = "Markdown 内容",
}: {
  readonly value: string;
  readonly label?: string;
}) {
  return (
    <section className="note-markdown" aria-label={label}>
      <header>
        <strong>{label}</strong>
        <small>安全渲染 · HTML与远程媒体已禁用 · 外链会显式提示</small>
      </header>
      <Suspense fallback={<p role="status">正在加载安全 Markdown 渲染器…</p>}>
        <NoteMarkdownRenderer value={value} />
      </Suspense>
    </section>
  );
}
