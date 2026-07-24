import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/styles.css", "utf8");

test("产品界面不再声明低于11px的可见字号", () => {
  const explicitSizes = [...styles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) =>
    Number(match[1]),
  );
  const shorthandSizes = [...styles.matchAll(/font:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px\s*\//gs)].map(
    (match) => Number(match[1]),
  );
  const undersized = [...explicitSizes, ...shorthandSizes].filter((value) => value < 11);

  assert.deepEqual(undersized, [], `发现低于11px的界面字号声明: ${undersized.join(", ")}`);
});
