export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "chat-theme";

/** 读取用户手动保存的主题偏好；未保存或非法值返回null。 */
export function readStoredTheme(storage: Pick<Storage, "getItem">): Theme | null {
  const value = storage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : null;
}

/** 当前生效主题：手动偏好优先；首次使用默认采用产品的明亮主题。 */
export function resolveTheme(storage: Pick<Storage, "getItem">): Theme {
  const stored = readStoredTheme(storage);
  return stored ?? "light";
}

/** 应用主题到根元素并保存手动偏好。 */
export function applyTheme(
  theme: Theme,
  root: Pick<HTMLElement, "dataset">,
  storage: Pick<Storage, "setItem">,
): void {
  root.dataset.theme = theme;
  storage.setItem(THEME_STORAGE_KEY, theme);
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}
