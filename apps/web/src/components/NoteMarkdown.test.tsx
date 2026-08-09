import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteMarkdown } from "./NoteMarkdown.js";

describe("NoteMarkdown", () => {
  it("渲染有限Markdown结构，但跳过raw HTML且不创建远程资源", async () => {
    render(
      <NoteMarkdown
        value={
          '# 标题\n\n- **重点**\n\n`code`\n\n![远程图](https://evil.invalid/x)\n\n<img src="https://evil.invalid/y" onerror="alert(1)">\n<script>alert(1)</script>'
        }
      />,
    );
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).not.toContain("alert(1)");
  });

  it("http(s)外链新窗口打开并显式提示，危险与相对协议不生成可点击链接", async () => {
    render(
      <NoteMarkdown
        value={
          "[安全外链](https://example.com/path)\n\n[脚本](javascript:alert(1))\n\n[相对链接](/private)\n\n[邮件](mailto:test@example.com)"
        }
      />,
    );
    const link = await screen.findByRole("link", { name: "安全外链" });
    expect(link.getAttribute("href")).toBe("https://example.com/path");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByLabelText("外部链接提示")).toBeTruthy();
    expect(screen.getAllByText("（链接已阻止）")).toHaveLength(3);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
