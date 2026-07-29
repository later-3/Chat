import { expect, test } from "@playwright/test";

test("API凭据失效时PWA给出可执行的重新登录入口", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 401,
      headers: { "www-authenticate": 'Basic realm="Chat private workspace"' },
      body: "Unauthorized",
    });
  });
  await page.route("**/auth-refresh.html", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>authentication challenge</title>",
    });
  });

  await page.goto("/");

  const dialog = page.getByRole("alertdialog", { name: "重新登录后继续" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("不会自动重发模型调用")).toBeVisible();
  await dialog.getByRole("button", { name: "重新登录" }).click();
  await expect(page).toHaveURL(/\/auth-refresh\.html$/);
});
