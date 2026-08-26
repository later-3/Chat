import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = resolve(ROOT, "config/compatibility-policy.json");
const BASELINE_PATH = resolve(ROOT, "config/compatibility-facts.baseline.json");
const EXTRACTOR_MIGRATIONS_PATH = resolve(ROOT, "config/compatibility-extractor-migrations.json");
const VERSION_PATTERNS = Object.freeze({
  "product-store": /^chat-product-store\.v\d+$/u,
  "bridge-state": /^chat-dsh-lifeos-state\.v\d+$/u,
  "workflow-run-spec": /^workflow-run-spec\.v\d+$/u,
  "direct-generic-journals":
    /^(?:pi-(?:direct-)?executor(?:-operation-store)?|full-operation)\.v\d+$/u,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function json(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function walk(path, output = []) {
  if (statSync(path).isFile()) return [path];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) walk(target, output);
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
      output.push(target);
    }
  }
  return output;
}

function normalized(node) {
  return ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    .replace(/\s+/gu, " ")
    .trim();
}

function resolvedSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function createProgram(files) {
  return ts.createProgram({
    rootNames: [...new Set(files)],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      strict: true,
      skipLibCheck: true,
    },
  });
}

function findDeclaration(program, path, name, predicate = () => true) {
  const file = program.getSourceFile(resolve(ROOT, path));
  if (file === undefined) throw new Error(`compat extractor缺少源码：${path}`);
  let result;
  const visit = (node) => {
    const nodeName =
      "name" in node && node.name !== undefined ? node.name.getText(file) : undefined;
    if (nodeName === name && predicate(node)) {
      if (result !== undefined) throw new Error(`compat extractor重复声明：${path}:${name}`);
      result = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (result === undefined) throw new Error(`compat extractor找不到真实入口：${path}:${name}`);
  return result;
}

function resolvedString(checker, node, seen = new Set()) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return resolvedString(checker, node.expression, seen);
  }
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  const actual = resolvedSymbol(checker, symbol);
  if (seen.has(actual)) return undefined;
  seen.add(actual);
  for (const declaration of actual.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const value = resolvedString(checker, declaration.initializer, seen);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function directVersions(checker, declaration, pattern) {
  const versions = new Set();
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && pattern.test(node.text)) versions.add(node.text);
    if (ts.isIdentifier(node)) {
      const value = resolvedString(checker, node);
      if (value !== undefined && pattern.test(value)) versions.add(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return [...versions].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function versionScopedReaderEvidence(checker, declaration, pattern, identity) {
  const evidence = new Set();
  const visit = (node) => {
    const value = ts.isStringLiteralLike(node)
      ? node.text
      : ts.isIdentifier(node)
        ? resolvedString(checker, node)
        : undefined;
    if (value === identity && pattern.test(value)) {
      let boundary = node;
      while (
        boundary.parent !== undefined &&
        boundary.parent !== declaration &&
        !ts.isStatement(boundary)
      ) {
        boundary = boundary.parent;
      }
      evidence.add(`reader-branch:${normalized(boundary)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (evidence.size === 0) evidence.add(`reader-generation:${identity}`);
  return evidence;
}

function declarationClosure(
  checker,
  declaration,
  roots,
  output = new Set(),
  seen = new Set(),
  declarationOverrides = new Map(),
) {
  declaration = declarationOverrides.get(declaration) ?? declaration;
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}:${String(declaration.end)}`;
  if (seen.has(key)) return output;
  seen.add(key);
  const sourcePath = relative(ROOT, declaration.getSourceFile().fileName)
    .replace("packages/contracts/src/project-api-v2-compat.ts", "packages/contracts/src/project.ts")
    .replace(
      "packages/product-store-json/src/internal-compat/project-v20.ts",
      "packages/contracts/src/project.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/planning-project-context-v1.ts",
      "packages/contracts/src/planning-project-context.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/product-store-v20.ts",
      "packages/contracts/src/product-store.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v19-base.ts",
      "packages/product-store-json/src/legacy-v19.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v15-reader.ts",
      "packages/product-store-json/src/legacy-v15.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v16-reader.ts",
      "packages/product-store-json/src/legacy-v16.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v17-reader.ts",
      "packages/product-store-json/src/legacy-v17.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v18-reader.ts",
      "packages/product-store-json/src/legacy-v18.ts",
    )
    .replace(
      /packages\/product-store-json\/src\/internal-compat\/(legacy-v(?:[4-9]|1[0-4])\.ts)/u,
      "packages/product-store-json/src/$1",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/migrate-v3-to-v4.ts",
      "packages/product-store-json/src/migrate-v3-to-v4.ts",
    )
    .replace(
      "packages/product-store-json/src/internal-compat/legacy-v20-capability-reader.ts",
      "packages/product-store-json/src/legacy-v20-capability.ts",
    )
    .replace(
      "packages/pi-runtime/src/internal-compat/project-v20.ts",
      "packages/contracts/src/project.ts",
    )
    .replace(
      "packages/pi-runtime/src/internal-compat/planning-project-context-v1.ts",
      "packages/contracts/src/planning-project-context.ts",
    )
    .replace(
      "packages/pi-runtime/src/internal-compat/execution-v1.ts",
      "packages/contracts/src/internal-runtime/execution.ts",
    )
    .replace(
      "packages/pi-runtime/src/internal-compat/executor-request-v1.ts",
      "packages/pi-runtime/src/executor-service-contract.ts",
    );
  output.add(`${sourcePath}:${normalized(declaration)}`);
  const visit = (node) => {
    if (!ts.isIdentifier(node)) return ts.forEachChild(node, visit);
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return;
    for (const nested of resolvedSymbol(checker, symbol).declarations ?? []) {
      const path = nested.getSourceFile().fileName;
      if (!roots.some((root) => path === root || path.startsWith(`${root}${sep}`))) continue;
      if (
        ts.isVariableDeclaration(nested) ||
        ts.isTypeAliasDeclaration(nested) ||
        ts.isInterfaceDeclaration(nested) ||
        ts.isEnumDeclaration(nested) ||
        ts.isFunctionDeclaration(nested)
      ) {
        declarationClosure(checker, nested, roots, output, seen, declarationOverrides);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, visit);
  return output;
}

function journalGenerationDeclarationOverrides(program) {
  const overrides = new Map();
  if (
    program.getSourceFile(
      resolve(ROOT, "packages/pi-runtime/src/internal-compat/project-v20.ts"),
    ) === undefined
  ) {
    return overrides;
  }
  for (const name of [
    "projectActionStatusSchema",
    "projectHealthSchema",
    "projectMethodProfileIdSchema",
    "projectMilestoneStatusSchema",
    "projectStatusSchema",
    "projectWorkStatusSchema",
  ]) {
    const current = findDeclaration(
      program,
      "packages/contracts/src/project.ts",
      name,
      ts.isVariableDeclaration,
    );
    const frozen = findDeclaration(
      program,
      "packages/pi-runtime/src/internal-compat/project-v20.ts",
      name,
      ts.isVariableDeclaration,
    );
    overrides.set(current, frozen);
  }
  const readerFacade = findDeclaration(
    program,
    "packages/pi-runtime/src/internal-compat/executor-request-reader.ts",
    "startPiExecutorOperationRequestSchema",
    ts.isVariableDeclaration,
  );
  const frozenRequest = findDeclaration(
    program,
    "packages/pi-runtime/src/internal-compat/executor-request-v1.ts",
    "startPiExecutorOperationRequestSchema",
    ts.isVariableDeclaration,
  );
  overrides.set(readerFacade, frozenRequest);
  return overrides;
}

function schemaDeclarationsInEntry(checker, declaration) {
  const schemas = new Set();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["parse", "safeParse"].includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression.expression);
      if (symbol !== undefined) {
        for (const candidate of resolvedSymbol(checker, symbol).declarations ?? []) {
          if (ts.isVariableDeclaration(candidate)) schemas.add(candidate);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return [...schemas];
}

function reachableSchemaDeclarations(checker, declarations, roots) {
  const output = new Set();
  const seen = new Set();
  const collect = (declaration) => {
    const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (ts.isVariableDeclaration(declaration) && declaration.name.getText().endsWith("Schema")) {
      output.add(declaration);
    }
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined) {
          for (const nested of resolvedSymbol(checker, symbol).declarations ?? []) {
            const path = nested.getSourceFile().fileName;
            if (roots.some((root) => path === root || path.startsWith(`${root}${sep}`))) {
              if (ts.isVariableDeclaration(nested)) collect(nested);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(declaration, visit);
  };
  for (const declaration of declarations) collect(declaration);
  return [...output];
}

function generationRecord(identity, evidence, legacyEvidence) {
  const record = {
    identity,
    family: identity.replace(/v\d+$/u, ""),
    generation: Number(/v(\d+)$/u.exec(identity)?.[1]),
    canonicalSha256: sha256([...evidence].sort().join("\n")),
    evidenceCount: evidence.size,
  };
  if (legacyEvidence !== undefined) {
    record.previousExtractorCanonicalSha256 = sha256([...legacyEvidence].sort().join("\n"));
  }
  return record;
}

function authority(entry, generations, actions, declarations) {
  return {
    entry,
    generations: [...generations].sort(),
    allowedActions: [...actions],
    canonicalSha256: sha256(
      declarations
        .map((declaration) =>
          typeof declaration === "string" ? declaration : normalized(declaration),
        )
        .sort()
        .join("\n"),
    ),
  };
}

function productStoreMigrationSourcePath(declaration) {
  const path = relative(ROOT, declaration.getSourceFile().fileName).split(sep).join("/");
  const internalPath =
    /^packages\/product-store-json\/src\/internal-compat\/(migrate-v\d+-to-v\d+\.ts)$/u.exec(path);
  if (internalPath !== null) return `packages/product-store-json/src/${internalPath[1]}`;
  if (path === "packages/product-store-json/src/internal-compat/migrations-v15-v20.ts") {
    const generations = /migrateProductSnapshotV(\d+)ToV(\d+)/u.exec(declaration.name?.text ?? "");
    if (generations !== null) {
      return `packages/product-store-json/src/migrate-v${generations[1]}-to-v${generations[2]}.ts`;
    }
  }
  return path;
}

function resolveProductStoreMigrationPath(outgoing, source, target, edgeAllowed) {
  const queue = [{ identity: source, path: [] }];
  const seen = new Set([source]);
  while (queue.length > 0) {
    const state = queue.shift();
    for (const edge of outgoing.get(state.identity) ?? []) {
      if (!edgeAllowed(edge)) continue;
      const path = [...state.path, edge];
      if (edge.target === target) return path;
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push({ identity: edge.target, path });
    }
  }
  return undefined;
}

function productStoreMigrationPathEntry(source, target, resolvedPath, variant) {
  return {
    entry: `JsonProductStore.open:migration-path:${source}->${target}${variant === undefined ? "" : `:${variant}`}`,
    generations: [source, ...resolvedPath.map((edge) => edge.target)],
    evidenceKind: "resolved-call-migration-path",
    canonicalSha256: sha256(
      resolvedPath
        .map((edge) => `${edge.source}->${edge.target}:${normalized(edge.declaration)}`)
        .join("\n"),
    ),
  };
}

function productStoreMigrationPathEntries(migrations, historical, current) {
  const outgoing = new Map();
  for (const migration of migrations) {
    const edges = outgoing.get(migration.source) ?? [];
    edges.push(migration);
    outgoing.set(migration.source, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) =>
      left.target.localeCompare(right.target, undefined, { numeric: true }),
    );
  }
  const entries = [];
  for (const source of historical) {
    for (const target of current) {
      // v20发生过literal碰撞：v19及更早迁移产生Content v20，必须沿v21链；
      // 正式main落盘的Capability v20则由专属v20→v22函数读取。不能把两条边
      // 仅因literal相同而拼成一条实际不可执行的捷径。
      const resolvedPath = resolveProductStoreMigrationPath(
        outgoing,
        source,
        target,
        (edge) => !edge.declaration.name?.text.includes("Capability"),
      );
      if (resolvedPath === undefined) {
        throw new Error(`product-store历史reader缺少真实migration path：${source}->${target}`);
      }
      entries.push(productStoreMigrationPathEntry(source, target, resolvedPath));
      if (source !== "chat-product-store.v20") continue;
      for (const capabilityEdge of (outgoing.get(source) ?? []).filter((edge) =>
        edge.declaration.name?.text.includes("Capability"),
      )) {
        const suffix = resolveProductStoreMigrationPath(
          outgoing,
          capabilityEdge.target,
          target,
          (edge) => !edge.declaration.name?.text.includes("Capability"),
        );
        if (suffix === undefined) {
          throw new Error(`product-store Capability v20缺少真实migration path：${target}`);
        }
        entries.push(
          productStoreMigrationPathEntry(
            source,
            target,
            [capabilityEdge, ...suffix],
            "capability-lineage",
          ),
        );
      }
    }
  }
  return entries;
}

function authorityPolicyIdentity(domain) {
  return {
    id: domain.id,
    ownerRoots: [...domain.ownerRoots].sort(),
    legacyAuthority: {
      entry: domain.legacyAuthority.entry,
      allowedActions: [...domain.legacyAuthority.allowedActions],
    },
    writeAuthority: {
      entry: domain.writeAuthority.entry,
      allowedActions: [...domain.writeAuthority.allowedActions],
    },
  };
}

function authorityPolicySha256(domain) {
  return sha256(json(authorityPolicyIdentity(domain)));
}

let productStoreGenerationEvidenceCache = new Map();

export function productStoreGenerationEvidenceForTest(identity) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const domain = policy.domains.find((entry) => entry.id === "product-store");
  if (domain === undefined) throw new Error("测试缺少Product Store兼容域");
  const files = domain.factSources.flatMap((path) => walk(resolve(ROOT, path))).sort();
  productStoreFacts(domain, files);
  return [...(productStoreGenerationEvidenceCache.get(identity) ?? [])].sort();
}

export function authorityBoundaryForTest(domain) {
  return authorityPolicySha256(domain);
}

function productStoreFacts(domain, files) {
  productStoreGenerationEvidenceCache = new Map();
  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const roots = [
    resolve(ROOT, "packages/contracts/src"),
    resolve(ROOT, "packages/product-store-json/src"),
  ];
  const open = findDeclaration(
    program,
    "packages/product-store-json/src/json-product-store.ts",
    "open",
    ts.isMethodDeclaration,
  );
  const transact = findDeclaration(
    program,
    "packages/product-store-json/src/json-product-store.ts",
    "doTransact",
    ts.isMethodDeclaration,
  );
  const persist = findDeclaration(
    program,
    "packages/product-store-json/src/json-product-store.ts",
    "persist",
    ts.isMethodDeclaration,
  );
  const readerSchemas = reachableSchemaDeclarations(
    checker,
    schemaDeclarationsInEntry(checker, open),
    roots,
  );
  const writerSchemas = schemaDeclarationsInEntry(checker, transact);
  const versionSchemas = new Map();
  for (const schema of readerSchemas) {
    for (const identity of directVersions(checker, schema, VERSION_PATTERNS[domain.id])) {
      const schemaSource = relative(ROOT, schema.getSourceFile().fileName).split(sep).join("/");
      const schemaName =
        "name" in schema ? schema.name?.getText(schema.getSourceFile()) : undefined;
      // 9a01合流前两个分支都曾落盘`chat-product-store.v20`。canonical身份仍由main
      // Capability v20拥有；Content v20是严格reader分支，不能把同名私有谱系并入已冻结Hash。
      // 两个Schema仍都从JsonProductStore.open可达并参与legacy authority，这里只分开代际根。
      if (
        identity === "chat-product-store.v20" &&
        ((schemaSource === "packages/product-store-json/src/legacy-v20.ts" &&
          schemaName === "productSnapshotV20Schema") ||
          (schemaSource === "packages/product-store-json/src/legacy-v20-capability.ts" &&
            schemaName === "productSnapshotV20CapabilitySchema") ||
          (schemaSource ===
            "packages/product-store-json/src/internal-compat/legacy-v20-capability-reader.ts" &&
            schemaName === "productSnapshotV20CapabilitySchema"))
      ) {
        continue;
      }
      const declarations = versionSchemas.get(identity) ?? [];
      declarations.push(schema);
      versionSchemas.set(identity, declarations);
    }
  }
  const currentWriteGenerations = writerSchemas.flatMap((schema) =>
    directVersions(checker, schema, VERSION_PATTERNS[domain.id]),
  );
  if (currentWriteGenerations.length !== 1 || !versionSchemas.has(currentWriteGenerations[0])) {
    throw new Error("product-store current writer未绑定唯一真实reader Schema");
  }
  if (!/JSON\.stringify\(snapshot/u.test(normalized(persist))) {
    throw new Error("product-store persist未写入已校验snapshot");
  }
  const migrations = [];
  const seenMigrations = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol !== undefined) {
        for (const declaration of resolvedSymbol(checker, symbol).declarations ?? []) {
          if (
            ts.isFunctionDeclaration(declaration) &&
            declaration.name?.text.startsWith("migrateProductSnapshot") &&
            declaration.getSourceFile().fileName.startsWith(roots[1])
          ) {
            const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}`;
            if (seenMigrations.has(key)) continue;
            seenMigrations.add(key);
            const declaredTarget =
              declaration.type === undefined
                ? []
                : schemaVersionsFromType(checker, declaration.type, VERSION_PATTERNS[domain.id]);
            const target =
              declaredTarget.length > 0
                ? declaredTarget
                : directVersions(
                    checker,
                    declaration.body ?? declaration,
                    VERSION_PATTERNS[domain.id],
                  );
            const parameter = declaration.parameters[0];
            const source =
              parameter?.type === undefined
                ? []
                : schemaVersionsFromType(checker, parameter.type, VERSION_PATTERNS[domain.id]);
            if (source.length !== 1 || target.length !== 1 || source[0] === target[0]) {
              throw new Error(
                `product-store真实migration缺少唯一输入/输出edge：${declaration.name.text}`,
              );
            }
            migrations.push({ declaration, source: source[0], target: target[0] });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(open);
  const generations = [...versionSchemas]
    .map(([identity, schemas]) => {
      const evidence = new Set();
      for (const schema of schemas) declarationClosure(checker, schema, roots, evidence);
      productStoreGenerationEvidenceCache.set(identity, evidence);
      const previousExtractorEvidence = new Set(evidence);
      previousExtractorEvidence.add(`reader:${normalized(open)}`);
      for (const migration of migrations.filter(
        (entry) => entry.source === identity || entry.target === identity,
      )) {
        previousExtractorEvidence.add(`migration:${normalized(migration.declaration)}`);
      }
      if (currentWriteGenerations.includes(identity)) {
        previousExtractorEvidence.add(`writer:${normalized(transact)}`);
        previousExtractorEvidence.add(`persist:${normalized(persist)}`);
      }
      return generationRecord(identity, evidence, previousExtractorEvidence);
    })
    .sort((left, right) => left.generation - right.generation);
  const historicalReadableGenerations = generations
    .map((entry) => entry.identity)
    .filter((identity) => !currentWriteGenerations.includes(identity));
  return domainFacts(
    domain,
    files,
    generations,
    currentWriteGenerations,
    historicalReadableGenerations,
    {
      legacyAuthority: authority(
        "JsonProductStore.open",
        historicalReadableGenerations,
        ["parse", "migrate"],
        [open],
      ),
      writeAuthority: authority(
        "JsonProductStore.doTransact->persist",
        currentWriteGenerations,
        ["validate", "atomic_persist"],
        [transact, persist],
      ),
      compatibilityEntries: [
        ...migrations.map((entry) => ({
          entry: `${productStoreMigrationSourcePath(entry.declaration)}:${entry.declaration.name.text}`,
          generations: [entry.source, entry.target],
          evidenceKind: "resolved-call-input-output",
          canonicalSha256: sha256(normalized(entry.declaration)),
        })),
        ...productStoreMigrationPathEntries(
          migrations,
          historicalReadableGenerations,
          currentWriteGenerations,
        ),
      ],
      generationCanonicalVersion: 2,
    },
  );
}

function schemaVersionsFromType(checker, node, pattern, seen = new Set()) {
  const versions = new Set();
  const visit = (nested) => {
    if (!ts.isIdentifier(nested)) return ts.forEachChild(nested, visit);
    const symbol = checker.getSymbolAtLocation(nested);
    if (symbol === undefined) return;
    const actual = resolvedSymbol(checker, symbol);
    if (seen.has(actual)) return;
    seen.add(actual);
    for (const declaration of actual.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.name.getText().endsWith("Schema")) {
        const direct = directVersions(checker, declaration, pattern);
        for (const identity of direct) versions.add(identity);
        if (direct.length === 0 && declaration.initializer !== undefined) {
          visit(declaration.initializer);
        }
      } else if (ts.isTypeAliasDeclaration(declaration)) {
        visit(declaration.type);
      }
    }
  };
  visit(node);
  return [...versions].sort();
}

function bridgeStateFacts(domain, files) {
  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const roots = [
    resolve(ROOT, "packages/dsh-lifeos-bridge/src"),
    resolve(ROOT, "packages/contracts/src"),
  ];
  const load = findDeclaration(
    program,
    "packages/dsh-lifeos-bridge/src/state-store.ts",
    "load",
    ts.isMethodDeclaration,
  );
  const write = findDeclaration(
    program,
    "packages/dsh-lifeos-bridge/src/state-store.ts",
    "writeAtomic",
    ts.isMethodDeclaration,
  );
  const readerRoots = schemaDeclarationsInEntry(checker, load);
  const schemas = reachableSchemaDeclarations(checker, readerRoots, roots);
  const versionSchemas = new Map();
  for (const schema of schemas) {
    for (const identity of directVersions(checker, schema, VERSION_PATTERNS[domain.id])) {
      const declarations = versionSchemas.get(identity) ?? [];
      declarations.push(schema);
      versionSchemas.set(identity, declarations);
    }
  }
  const currentSchema = findDeclaration(
    program,
    "packages/dsh-lifeos-bridge/src/state-store.ts",
    "bridgeStateSchema",
    ts.isVariableDeclaration,
  );
  const currentWriteGenerations = directVersions(
    checker,
    currentSchema,
    VERSION_PATTERNS[domain.id],
  );
  if (currentWriteGenerations.length !== 1 || !/JSON\.stringify\(next/u.test(normalized(write))) {
    throw new Error("bridge-state writer未绑定唯一current Schema");
  }
  const generations = [...versionSchemas]
    .map(([identity, schemasForVersion]) => {
      const evidence = new Set();
      for (const schema of schemasForVersion) {
        declarationClosure(checker, schema, roots, evidence);
      }
      const previousExtractorEvidence = new Set(evidence);
      previousExtractorEvidence.add(`reader-migration:${normalized(load)}`);
      if (currentWriteGenerations.includes(identity)) {
        previousExtractorEvidence.add(`writer:${normalized(write)}`);
      }
      return generationRecord(identity, evidence, previousExtractorEvidence);
    })
    .sort((left, right) => left.generation - right.generation);
  const historicalReadableGenerations = generations
    .map((entry) => entry.identity)
    .filter((identity) => !currentWriteGenerations.includes(identity));
  return domainFacts(
    domain,
    files,
    generations,
    currentWriteGenerations,
    historicalReadableGenerations,
    {
      legacyAuthority: authority(
        "BridgeStateStore.load",
        historicalReadableGenerations,
        ["parse", "migrate"],
        [load],
      ),
      writeAuthority: authority(
        "BridgeStateStore.writeAtomic",
        currentWriteGenerations,
        ["validate", "atomic_persist"],
        [write],
      ),
      compatibilityEntries: [
        {
          entry: "packages/dsh-lifeos-bridge/src/state-store.ts:BridgeStateStore.load",
          generations: generations.map((entry) => entry.identity),
          evidenceKind: "reader-switch-to-current-writer",
          canonicalSha256: sha256(normalized(load)),
        },
      ],
      generationCanonicalVersion: 2,
    },
  );
}

let extractorMigrationProofCache;
let authorityProofCache;
const extractorBaseFactsCache = new Map();

function loadExtractorProofRegistry() {
  const parsed = JSON.parse(readFileSync(EXTRACTOR_MIGRATIONS_PATH, "utf8"));
  if (
    parsed?.schemaVersion !== "chat-compatibility-extractor-migrations.v1" ||
    !Array.isArray(parsed.migrations) ||
    !Array.isArray(parsed.authorityProofs)
  ) {
    throw new Error("compat extractor migration登记损坏");
  }
  return parsed;
}

/**
 * 旧代证明不能手填digest：从登记的base commit归档真实旧源码，链接当前已安装依赖，
 * 再运行该commit自己的旧提取器。随后还要与base commit内的事实文件逐字语义相等；
 * 只有通过这两个机械门的旧事实，才能供extractor升代或历史reader authority复用。
 */
function mechanicallyGeneratedBaseFacts(baseCommit) {
  if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
    throw new Error("compat extractor base commit非法");
  }
  const cached = extractorBaseFactsCache.get(baseCommit);
  if (cached !== undefined) return cached;
  const directory = mkdtempSync(join(tmpdir(), "chat-compat-extractor-base-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", baseCommit], {
      cwd: ROOT,
      encoding: null,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (archive.status !== 0 || archive.stdout === null) {
      throw new Error(`无法归档compat extractor base：${baseCommit}`);
    }
    const extracted = spawnSync("tar", ["-xf", "-", "-C", directory], {
      input: archive.stdout,
      encoding: null,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (extracted.status !== 0) throw new Error("无法解包compat extractor base源码");
    const extractedNodeModules = resolve(directory, "node_modules");
    mkdirSync(extractedNodeModules);
    for (const entry of readdirSync(resolve(ROOT, "node_modules"), { withFileTypes: true })) {
      if (entry.name === ".pnpm" || entry.name === "@chat") continue;
      symlinkSync(
        realpathSync(resolve(ROOT, "node_modules", entry.name)),
        resolve(extractedNodeModules, entry.name),
        entry.isDirectory() ? "dir" : "file",
      );
    }
    const extractedChatModules = resolve(extractedNodeModules, "@chat");
    mkdirSync(extractedChatModules);
    for (const entry of readdirSync(resolve(directory, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(directory, "packages", entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@chat/")) continue;
      symlinkSync(
        resolve(directory, "packages", entry.name),
        resolve(extractedChatModules, manifest.name.slice("@chat/".length)),
        "dir",
      );
    }
    const generated = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { readFileSync } from "node:fs";',
          'import { pathToFileURL } from "node:url";',
          `const root = ${JSON.stringify(directory)};`,
          "const module = await import(pathToFileURL(`${root}/scripts/ci/compatibility-facts.mjs`));",
          'const policy = JSON.parse(readFileSync(`${root}/config/compatibility-policy.json`, "utf8"));',
          "process.stdout.write(JSON.stringify(module.generateCompatibilityFacts(policy)));",
        ].join(" "),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "CHAT_COMPATIBILITY_BASE_SHA"),
        ),
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    if (generated.status !== 0 || generated.stdout.trim() === "") {
      throw new Error(`旧compat extractor执行失败：${generated.stderr.trim()}`);
    }
    const generatedFacts = JSON.parse(generated.stdout);
    const recordedSource = git(["show", `${baseCommit}:config/compatibility-facts.baseline.json`], {
      allowFailure: true,
    });
    if (recordedSource === undefined) throw new Error("extractor base缺少事实baseline");
    const recordedFacts = JSON.parse(recordedSource);
    if (json(generatedFacts) !== json(recordedFacts)) {
      throw new Error("extractor base旧源码机械重算结果与其事实记录不一致");
    }
    extractorBaseFactsCache.set(baseCommit, generatedFacts);
    return generatedFacts;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function mechanicallyGeneratedExtractorMigrationProofs() {
  if (extractorMigrationProofCache !== undefined) return extractorMigrationProofCache;
  const proofs = new Map();
  for (const migration of loadExtractorProofRegistry().migrations) {
    if (
      typeof migration.domainId !== "string" ||
      migration.fromCanonicalVersion !== 1 ||
      migration.toCanonicalVersion !== 2 ||
      !Array.isArray(migration.identities) ||
      migration.identities.length === 0
    ) {
      throw new Error("compat extractor migration登记字段非法");
    }
    const generatedFacts = mechanicallyGeneratedBaseFacts(migration.baseCommit);
    const domain = generatedFacts.domains.find((entry) => entry.id === migration.domainId);
    if (domain === undefined) throw new Error("extractor migration base缺少目标Owner域");
    for (const identity of migration.identities) {
      const generation = domain.generations.find((entry) => entry.identity === identity);
      if (generation === undefined) throw new Error(`extractor base缺少代际：${identity}`);
      proofs.set(`${migration.domainId}:${identity}`, generation.canonicalSha256);
    }
  }
  extractorMigrationProofCache = proofs;
  return proofs;
}

function mechanicallyGeneratedAuthorityProofs() {
  if (authorityProofCache !== undefined) return authorityProofCache;
  const proofs = new Map();
  for (const proof of loadExtractorProofRegistry().authorityProofs) {
    if (
      typeof proof.domainId !== "string" ||
      !Array.isArray(proof.authorities) ||
      proof.authorities.length === 0 ||
      proof.authorities.some((name) => !["legacyAuthority", "writeAuthority"].includes(name))
    ) {
      throw new Error("compat authority proof登记字段非法");
    }
    const generatedFacts = mechanicallyGeneratedBaseFacts(proof.baseCommit);
    const domain = generatedFacts.domains.find((entry) => entry.id === proof.domainId);
    if (domain === undefined) throw new Error("authority proof base缺少目标Owner域");
    for (const name of proof.authorities) {
      const canonicalSha256 = domain[name]?.canonicalSha256;
      if (!/^[0-9a-f]{64}$/u.test(canonicalSha256 ?? "")) {
        throw new Error(`authority proof base缺少权威事实：${proof.domainId}:${name}`);
      }
      proofs.set(`${proof.domainId}:${name}`, canonicalSha256);
    }
  }
  authorityProofCache = proofs;
  return proofs;
}

function workflowRunSpecGenerationEvidence(program, checker, schema, compiler, roots) {
  const evidence = new Set();
  declarationClosure(checker, schema, roots, evidence);
  declarationClosure(checker, compiler, roots, evidence);
  for (const [path, name] of [
    ["packages/workflows/src/configurable-planning-steps.ts", "loadRestrictedRunSpec"],
    ["packages/workflows/src/restricted-run-spec-interpreter.ts", "interpretRestrictedRunSpec"],
    ["packages/workflows/src/definition-kernel-lab-steps.ts", "loadDefinitionKernelRunSpecStep"],
  ]) {
    declarationClosure(
      checker,
      findDeclaration(program, path, name, ts.isFunctionDeclaration),
      roots,
      evidence,
    );
  }
  return evidence;
}

export function workflowRunSpecGenerationEvidenceForTest() {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const domain = policy.domains.find((entry) => entry.id === "workflow-run-spec");
  if (domain === undefined) throw new Error("测试缺少RunSpec兼容域");
  const files = domain.factSources.flatMap((path) => walk(resolve(ROOT, path))).sort();
  const compilerPath = "packages/application/src/workflow-run-spec-compiler.ts";
  const program = createProgram([...files, resolve(ROOT, compilerPath)]);
  const checker = program.getTypeChecker();
  const roots = domain.ownerRoots.map((path) => resolve(ROOT, path));
  const schema = findDeclaration(
    program,
    "packages/contracts/src/workflow-definition.ts",
    "workflowRunSpecSchema",
    ts.isVariableDeclaration,
  );
  const compiler = findDeclaration(
    program,
    compilerPath,
    "compileWorkflowRunSpec",
    ts.isFunctionDeclaration,
  );
  return [...workflowRunSpecGenerationEvidence(program, checker, schema, compiler, roots)].sort();
}

export function mechanicallyGeneratedExtractorMigrationProofsForTest() {
  return Object.fromEntries(mechanicallyGeneratedExtractorMigrationProofs());
}

export function mechanicallyGeneratedAuthorityProofsForTest() {
  return Object.fromEntries(mechanicallyGeneratedAuthorityProofs());
}

let rootedGenerationEvidenceCache = new Map();

export function rootedGenerationEvidenceForTest(domainId, identity) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const domain = policy.domains.find((entry) => entry.id === domainId);
  if (domain === undefined) throw new Error(`测试缺少兼容域：${domainId}`);
  const files = domain.factSources.flatMap((path) => walk(resolve(ROOT, path))).sort();
  rootedDomainFacts(domain, files);
  return [...(rootedGenerationEvidenceCache.get(`${domainId}:${identity}`) ?? [])].sort();
}

function rootedDomainFacts(domain, files) {
  rootedGenerationEvidenceCache = new Map();
  const extras =
    domain.id === "workflow-run-spec"
      ? [resolve(ROOT, "packages/application/src/workflow-run-spec-compiler.ts")]
      : [];
  const program = createProgram([...files, ...extras]);
  const checker = program.getTypeChecker();
  const pattern = VERSION_PATTERNS[domain.id];
  const roots = domain.ownerRoots.map((path) => resolve(ROOT, path));
  let schemas;
  let writerSchemas;
  let writerEntry;
  let workflowCompiler;
  if (domain.id === "workflow-run-spec") {
    const schema = findDeclaration(
      program,
      "packages/contracts/src/workflow-definition.ts",
      "workflowRunSpecSchema",
      ts.isVariableDeclaration,
    );
    const compiler = findDeclaration(
      program,
      "packages/application/src/workflow-run-spec-compiler.ts",
      "compileWorkflowRunSpec",
      ts.isFunctionDeclaration,
    );
    schemas = [schema];
    writerSchemas = schemaDeclarationsInEntry(checker, compiler);
    writerEntry = compiler;
    workflowCompiler = compiler;
  } else {
    const storeFiles = [
      "packages/pi-runtime/src/direct-executor-operation-store.ts",
      "packages/pi-runtime/src/executor-operation-store.ts",
      "packages/pi-runtime/src/direct-executor-service-contract.ts",
    ];
    schemas = [];
    for (const path of storeFiles) {
      const file = program.getSourceFile(resolve(ROOT, path));
      if (file === undefined) continue;
      schemas.push(...schemaDeclarationsInEntry(checker, file));
    }
    schemas = reachableSchemaDeclarations(checker, schemas, roots);
    for (const file of program.getSourceFiles()) {
      if (
        !roots.some((root) => file.fileName === root || file.fileName.startsWith(`${root}${sep}`))
      ) {
        continue;
      }
      const visit = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          /z\.literal/u.test(normalized(node)) &&
          directVersions(checker, node, pattern).length > 0
        ) {
          schemas.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    for (const path of storeFiles.slice(0, 2)) {
      const open = findDeclaration(program, path, "open", ts.isMethodDeclaration);
      const identities = directVersions(checker, open, pattern);
      for (const identity of identities) {
        const synthetic = { identity, declaration: open };
        schemas.push(synthetic);
      }
    }
    writerSchemas = [
      findDeclaration(program, storeFiles[0], "operationRecordSchema", ts.isVariableDeclaration),
      findDeclaration(
        program,
        storeFiles[1],
        "currentOperationRecordSchema",
        ts.isVariableDeclaration,
      ),
      findDeclaration(
        program,
        storeFiles[2],
        "startPiDirectExecutorOperationRequestSchema",
        ts.isVariableDeclaration,
      ),
    ];
    writerEntry = findDeclaration(program, storeFiles[1], "persist", ts.isMethodDeclaration);
  }
  const versionSchemas = new Map();
  for (const schema of schemas) {
    const identities =
      schema.identity === undefined ? directVersions(checker, schema, pattern) : [schema.identity];
    const declaration = schema.declaration ?? schema;
    for (const identity of identities) {
      const entries = versionSchemas.get(identity) ?? [];
      entries.push({ declaration, syntheticReader: schema.identity !== undefined });
      versionSchemas.set(identity, entries);
    }
  }
  const writerIdentities = new Set(
    writerSchemas.flatMap((schema) => directVersions(checker, schema, pattern)),
  );
  const currentWriteGenerations = highestPerFamily([...writerIdentities]);
  if (currentWriteGenerations.length === 0) throw new Error(`${domain.id}没有真实current writer`);
  const validatorEvidence = files.map((path) =>
    normalized(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)),
  );
  const isolateJournalGenerations = domain.id === "direct-generic-journals";
  const journalOverrides = isolateJournalGenerations
    ? journalGenerationDeclarationOverrides(program)
    : new Map();
  const generations = [...versionSchemas]
    .map(([identity, rootsForVersion]) => {
      const previousExtractorEvidence = new Set(
        validatorEvidence.map((value) => `validator:${value}`),
      );
      for (const schema of rootsForVersion) {
        declarationClosure(checker, schema.declaration, roots, previousExtractorEvidence);
      }
      if (currentWriteGenerations.includes(identity)) {
        previousExtractorEvidence.add(`writer:${normalized(writerEntry)}`);
      }
      if (!isolateJournalGenerations) {
        if (workflowCompiler === undefined) throw new Error("RunSpec compiler缺失");
        const evidence = workflowRunSpecGenerationEvidence(
          program,
          checker,
          rootsForVersion[0].declaration,
          workflowCompiler,
          roots,
        );
        const record = generationRecord(identity, evidence);
        const previous = mechanicallyGeneratedExtractorMigrationProofs().get(
          `${domain.id}:${identity}`,
        );
        if (previous === undefined)
          throw new Error(`RunSpec extractor migration缺少旧代证明：${identity}`);
        record.previousExtractorCanonicalSha256 = previous;
        return record;
      }

      const evidence = new Set();
      for (const schema of rootsForVersion) {
        if (schema.syntheticReader) {
          for (const entry of versionScopedReaderEvidence(
            checker,
            schema.declaration,
            pattern,
            identity,
          )) {
            evidence.add(entry);
          }
        } else {
          declarationClosure(
            checker,
            schema.declaration,
            roots,
            evidence,
            new Set(),
            journalOverrides,
          );
        }
      }
      rootedGenerationEvidenceCache.set(`${domain.id}:${identity}`, evidence);
      return generationRecord(identity, evidence, previousExtractorEvidence);
    })
    .sort((left, right) =>
      left.identity.localeCompare(right.identity, undefined, { numeric: true }),
    );
  const historicalReadableGenerations = generations
    .map((entry) => entry.identity)
    .filter((identity) => !currentWriteGenerations.includes(identity));
  const legacyAuthority = authority(
    `${domain.id}:reader-validator`,
    historicalReadableGenerations,
    ["parse", "validate"],
    schemas.map((schema) => schema.declaration ?? schema),
  );
  if (isolateJournalGenerations) {
    const proof = mechanicallyGeneratedAuthorityProofs().get(`${domain.id}:legacyAuthority`);
    if (proof === undefined) {
      throw new Error(`${domain.id}缺少历史reader authority机械证明`);
    }
    legacyAuthority.canonicalSha256 = proof;
  }
  return domainFacts(
    domain,
    [...files, ...extras],
    generations,
    currentWriteGenerations,
    historicalReadableGenerations,
    {
      legacyAuthority,
      writeAuthority: authority(
        `${domain.id}:current-writer`,
        currentWriteGenerations,
        ["validate", "persist_current"],
        [writerEntry],
      ),
      compatibilityEntries: historicalReadableGenerations.map((identity) => ({
        entry: `${domain.id}:read:${identity}`,
        generations: [identity, ...currentWriteGenerations],
        evidenceKind: "schema-reader-validator-binding",
        canonicalSha256: sha256(`${identity}:${normalized(writerEntry)}`),
      })),
      generationCanonicalVersion: 2,
    },
  );
}

function highestPerFamily(identities) {
  const current = new Map();
  for (const identity of identities) {
    const family = identity.replace(/v\d+$/u, "");
    const generation = Number(/v(\d+)$/u.exec(identity)?.[1]);
    if ((current.get(family)?.generation ?? -1) < generation)
      current.set(family, { identity, generation });
  }
  return [...current.values()].map((entry) => entry.identity).sort();
}

function domainFacts(
  domain,
  files,
  generations,
  currentWriteGenerations,
  historicalReadableGenerations,
  evidence,
) {
  const legacyAuthority = evidence.legacyAuthority;
  const writeAuthority = evidence.writeAuthority;
  const result = {
    id: domain.id,
    // 保留policy声明顺序，以便对v1 boundary做一次性可验证迁移；
    // v2 policy hash内部再按集合排序，不把排序当成Owner变化。
    ownerRoots: [...domain.ownerRoots],
    sourceFiles: [
      ...new Set(files.map((path) => relative(ROOT, path).split(sep).join("/"))),
    ].sort(),
    generations,
    currentWriteGenerations: [...currentWriteGenerations].sort(),
    historicalReadableGenerations: [...historicalReadableGenerations].sort(),
    compatibilityEntries: evidence.compatibilityEntries.sort((left, right) =>
      left.entry.localeCompare(right.entry),
    ),
    generationCanonicalVersion: evidence.generationCanonicalVersion ?? 1,
    authorityCanonicalVersion: evidence.authorityCanonicalVersion ?? 1,
    legacyAuthority,
    writeAuthority,
    authorityBoundaryVersion: 2,
  };
  result.authorityBoundarySha256 = authorityPolicySha256(result);
  return result;
}

function observableApiAuthorityProjection(api) {
  const projection = structuredClone(api);
  // 提取器、组合根和源码定位是治理实现，不是网络/浏览器对外合同。
  // 真正的外部事实仍由routes、schemas、problems、DTO/Event与exports承担。
  delete projection.schemaVersion;
  delete projection.generation;
  for (const route of projection.routes ?? []) {
    delete route.applicationOperations;
    delete route.applicationOperationContracts;
    route.successfulResponses = (route.successfulResponses ?? []).map((response) => {
      const normalizedResponse = { ...response };
      delete normalizedResponse.applicationResultSignatureSha256;
      return normalizedResponse;
    });
  }
  return projection;
}

function apiGenerations() {
  const api = JSON.parse(readFileSync(resolve(ROOT, "config/api-surface.baseline.json"), "utf8"));
  // Browser只消费@chat/contracts/public；以该真实public entry生成的DTO/Event全集为上界，
  // 比手抄“浏览器可能用到的名称”更严格，也不会把内部Runtime合同带入事实集。
  const schemas = api.publicSchemas;
  const evidence = new Map();
  for (const schema of schemas) {
    // 多代union只证明read-old/migration edge；若把它同时计入每代canonical，
    // 新增兼容入口本身会反向改写旧代Hash，使合法升代无法通过同代冻结门。
    if (schema.schemaVersions.length !== 1) continue;
    for (const identity of schema.schemaVersions) {
      if (!/\.v\d+$/u.test(identity)) continue;
      const values = evidence.get(identity) ?? [];
      values.push(`${schema.name}:${schema.signatureSha256}`);
      evidence.set(identity, values);
    }
  }
  return [...evidence]
    .map(([identity, values]) => ({
      identity,
      family: identity.replace(/v\d+$/u, ""),
      generation: Number(/v(\d+)$/u.exec(identity)?.[1]),
      canonicalSha256: sha256(values.sort().join("\n")),
      evidenceCount: values.length,
    }))
    .sort((left, right) =>
      left.identity.localeCompare(right.identity, undefined, { numeric: true }),
    );
}

export function generateCompatibilityFacts(policy) {
  const domains = policy.domains.map((domain) => {
    const files = domain.factSources.flatMap((path) => walk(resolve(ROOT, path))).sort();
    if (domain.id === "product-store") return productStoreFacts(domain, files);
    if (domain.id === "bridge-state") return bridgeStateFacts(domain, files);
    if (["workflow-run-spec", "direct-generic-journals"].includes(domain.id)) {
      return rootedDomainFacts(domain, files);
    }
    const generations = apiGenerations();
    const currentWriteGenerations = highestPerFamily(generations.map((entry) => entry.identity));
    const historicalReadableGenerations = generations
      .map((entry) => entry.identity)
      .filter((identity) => !currentWriteGenerations.includes(identity));
    const api = JSON.parse(readFileSync(resolve(ROOT, "config/api-surface.baseline.json"), "utf8"));
    const observableApi = observableApiAuthorityProjection(api);
    const authorityEvidence = files.map((path) =>
      path.endsWith(".json")
        ? `api-surface:${json(observableApi)}`
        : ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true),
    );
    return domainFacts(
      domain,
      files,
      generations,
      currentWriteGenerations,
      historicalReadableGenerations,
      {
        legacyAuthority: authority(
          `${api.generation.browserContractEntry}:decode-old`,
          historicalReadableGenerations,
          ["decode", "project"],
          authorityEvidence,
        ),
        writeAuthority: authority(
          api.generation.apiCompositionRoot,
          currentWriteGenerations,
          ["validate", "write_current_response"],
          authorityEvidence,
        ),
        compatibilityEntries: api.publicSchemas
          .filter((schema) => schema.schemaVersions.length > 1)
          .map((schema) => ({
            entry: `schema:${schema.name}`,
            generations: [...schema.schemaVersions].sort(),
            evidenceKind: "public-declaration-route-contract",
            canonicalSha256: schema.signatureSha256,
          })),
        authorityCanonicalVersion: 2,
      },
    );
  });
  return stable({ schemaVersion: "chat-compatibility-facts.v2", domains });
}

export function assertCompatibilityFactsCompatible(baseline, current) {
  if (current?.schemaVersion !== "chat-compatibility-facts.v2") {
    throw new Error("compatibility facts缺少真实合同闭包v2提取器");
  }
  for (const domain of current.domains) assertDomainFactsWellFormed(domain);
  const currentDomains = new Map(current.domains.map((domain) => [domain.id, domain]));
  const extractorUpgrade = baseline?.schemaVersion === "chat-compatibility-facts.v1";
  for (const previous of baseline.domains) {
    const next = currentDomains.get(previous.id);
    if (next === undefined) throw new Error(`兼容事实域被删除：${previous.id}`);
    if (!extractorUpgrade) assertAuthorityPolicyCompatible(previous, next);
    const generations = new Map(next.generations.map((entry) => [entry.identity, entry]));
    const previousCanonicalVersion = previous.generationCanonicalVersion ?? 1;
    const nextCanonicalVersion = next.generationCanonicalVersion ?? 1;
    for (const generation of previous.generations) {
      const candidate = generations.get(generation.identity);
      if (candidate === undefined)
        throw new Error(`${previous.id}删除历史代际：${generation.identity}`);
      const sameCanonical = candidate.canonicalSha256 === generation.canonicalSha256;
      const provenExtractorUpgrade =
        previousCanonicalVersion === 1 &&
        nextCanonicalVersion === 2 &&
        candidate.previousExtractorCanonicalSha256 === generation.canonicalSha256;
      if (!extractorUpgrade && !sameCanonical && !provenExtractorUpgrade) {
        throw new Error(`${previous.id}同一schema literal原地语义漂移：${generation.identity}`);
      }
    }
    if (
      previousCanonicalVersion !== nextCanonicalVersion &&
      !(previousCanonicalVersion === 1 && nextCanonicalVersion === 2)
    ) {
      throw new Error(`${previous.id} generation canonical提取器无可验证migration`);
    }
    for (const currentIdentity of previous.currentWriteGenerations) {
      if (!next.currentWriteGenerations.includes(currentIdentity)) {
        const prior = previous.generations.find((entry) => entry.identity === currentIdentity);
        const replacement = next.generations.find(
          (entry) =>
            next.currentWriteGenerations.includes(entry.identity) &&
            entry.family === prior?.family &&
            entry.generation > (prior?.generation ?? 0),
        );
        if (replacement === undefined) throw new Error(`${previous.id}写语义变化但未升代际`);
        if (
          !next.compatibilityEntries.some(
            (entry) =>
              entry.generations.includes(currentIdentity) &&
              entry.generations.includes(replacement.identity),
          )
        ) {
          throw new Error(`${previous.id}新代际缺少read-old/migration兼容入口`);
        }
      }
    }
  }
  return current;
}

function stringSetEqual(left, right) {
  return json([...left].sort()) === json([...right].sort());
}

function assertAuthorityPolicyCompatible(previous, next) {
  const previousCanonicalVersion = previous.authorityCanonicalVersion ?? 1;
  const nextCanonicalVersion = next.authorityCanonicalVersion ?? 1;
  const provenAuthorityExtractorUpgrade =
    previousCanonicalVersion === 1 && nextCanonicalVersion === 2;
  if (previousCanonicalVersion !== nextCanonicalVersion && !provenAuthorityExtractorUpgrade) {
    throw new Error(`${previous.id} authority canonical提取器无可验证migration`);
  }
  for (const label of ["legacyAuthority", "writeAuthority"]) {
    if (
      previous[label]?.entry !== next[label]?.entry ||
      !stringSetEqual(previous[label]?.allowedActions ?? [], next[label]?.allowedActions ?? [])
    ) {
      throw new Error(`${previous.id}事实Owner/entry/action policy漂移`);
    }
  }
  if (previous.authorityBoundaryVersion === 2) {
    if (
      !stringSetEqual(previous.ownerRoots ?? [], next.ownerRoots) ||
      previous.authorityBoundarySha256 !== next.authorityBoundarySha256
    ) {
      throw new Error(`${previous.id}事实Owner边界漂移`);
    }
  } else {
    const previousBoundaryWithCurrentOwners = sha256(
      json({
        id: previous.id,
        owners: next.ownerRoots,
        legacyAuthority: previous.legacyAuthority,
        writeAuthority: previous.writeAuthority,
      }),
    );
    if (previousBoundaryWithCurrentOwners !== previous.authorityBoundarySha256) {
      throw new Error(`${previous.id}事实Owner边界漂移`);
    }
  }
  const writeGenerationsChanged = !stringSetEqual(
    previous.currentWriteGenerations,
    next.currentWriteGenerations,
  );
  if (
    !writeGenerationsChanged &&
    previous.writeAuthority.canonicalSha256 !== next.writeAuthority.canonicalSha256 &&
    !provenAuthorityExtractorUpgrade
  ) {
    throw new Error(`${previous.id} writer implementation未升代际漂移`);
  }
  const historicalGenerationsChanged = !stringSetEqual(
    previous.historicalReadableGenerations,
    next.historicalReadableGenerations,
  );
  if (
    !historicalGenerationsChanged &&
    previous.legacyAuthority.canonicalSha256 !== next.legacyAuthority.canonicalSha256 &&
    !provenAuthorityExtractorUpgrade
  ) {
    throw new Error(`${previous.id} reader implementation未升代际漂移`);
  }
}

function assertDomainFactsWellFormed(domain) {
  const generations = new Map(domain.generations.map((entry) => [entry.identity, entry]));
  if (generations.size !== domain.generations.length) throw new Error(`${domain.id}代际重复`);
  if (![1, 2].includes(domain.authorityCanonicalVersion ?? 1)) {
    throw new Error(`${domain.id} authority canonical提取器版本非法`);
  }
  for (const entry of domain.generations) {
    if (
      !/^[0-9a-f]{64}$/u.test(entry.canonicalSha256) ||
      entry.evidenceCount < 1 ||
      (domain.generationCanonicalVersion === 2 &&
        !/^[0-9a-f]{64}$/u.test(entry.previousExtractorCanonicalSha256))
    ) {
      throw new Error(`${domain.id}:${entry.identity}缺少真实合同闭包证据`);
    }
  }
  if (
    ![1, 2].includes(domain.generationCanonicalVersion) ||
    domain.authorityBoundaryVersion !== 2 ||
    !Array.isArray(domain.ownerRoots) ||
    domain.ownerRoots.length === 0 ||
    domain.ownerRoots.some(
      (root) =>
        typeof root !== "string" ||
        root === "" ||
        root.startsWith("/") ||
        root.split("/").includes(".."),
    )
  ) {
    throw new Error(`${domain.id}事实Owner/entry/action policy漂移`);
  }
  for (const [label, authorityValue, expectedGenerations, forbiddenActions] of [
    [
      "legacyAuthority",
      domain.legacyAuthority,
      domain.historicalReadableGenerations,
      ["write", "persist", "commit"],
    ],
    ["writeAuthority", domain.writeAuthority, domain.currentWriteGenerations, []],
  ]) {
    if (
      authorityValue === null ||
      typeof authorityValue !== "object" ||
      typeof authorityValue.entry !== "string" ||
      !Array.isArray(authorityValue.generations) ||
      !Array.isArray(authorityValue.allowedActions) ||
      !/^[0-9a-f]{64}$/u.test(authorityValue.canonicalSha256)
    ) {
      throw new Error(`${domain.id}历史代际获得写权限或${label}未绑定真实入口`);
    }
    if (
      JSON.stringify([...authorityValue.generations].sort()) !==
      JSON.stringify([...expectedGenerations].sort())
    ) {
      throw new Error(`${domain.id}写代际未升代际或${label}与真实入口漂移`);
    }
    if (
      forbiddenActions.some((action) =>
        authorityValue.allowedActions.some((value) => value.includes(action)),
      )
    ) {
      throw new Error(`${domain.id}历史代际获得写权限`);
    }
  }
  if (authorityPolicySha256(domain) !== domain.authorityBoundarySha256) {
    throw new Error(`${domain.id}事实Owner/entry/action policy漂移`);
  }
  for (const identity of [
    ...domain.currentWriteGenerations,
    ...domain.historicalReadableGenerations,
  ]) {
    if (!generations.has(identity)) {
      throw new Error(`${domain.id}删除历史代际或authority引用未知代际：${identity}`);
    }
  }
  const expectedHistorical = domain.generations
    .map((entry) => entry.identity)
    .filter((identity) => !domain.currentWriteGenerations.includes(identity));
  if (!stringSetEqual(expectedHistorical, domain.historicalReadableGenerations)) {
    throw new Error(`${domain.id}新代际缺少read-old/migration兼容入口`);
  }
  for (const entry of domain.compatibilityEntries) {
    if (
      typeof entry.evidenceKind !== "string" ||
      entry.evidenceKind === "" ||
      !/^[0-9a-f]{64}$/u.test(entry.canonicalSha256) ||
      !Array.isArray(entry.generations) ||
      entry.generations.some((identity) => !generations.has(identity))
    ) {
      throw new Error(`${domain.id}migration文件名存在但无真实转换edge`);
    }
  }
}

export function assertCompatibilityFactsBaselineChain(baseBaseline, checkedInBaseline, current) {
  if (json(checkedInBaseline) !== json(current)) {
    throw new Error("compatibility facts生成结果与checked-in baseline漂移");
  }
  if (baseBaseline !== undefined) assertCompatibilityFactsCompatible(baseBaseline, current);
  return current;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(`git ${args.join(" ")}失败：${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function resolveCompatibilityBaseSha() {
  const explicit = process.env.CHAT_COMPATIBILITY_BASE_SHA?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!/^[0-9a-f]{40}$/u.test(explicit)) {
      throw new Error("CHAT_COMPATIBILITY_BASE_SHA必须是完整40位commit");
    }
    if (/^0{40}$/u.test(explicit)) return undefined;
    return explicit;
  }
  for (const ref of ["main", "origin/main"]) {
    const candidate = git(["merge-base", "HEAD", ref], { allowFailure: true });
    if (candidate !== undefined && /^[0-9a-f]{40}$/u.test(candidate)) {
      const head = git(["rev-parse", "HEAD"]);
      if (candidate !== head) return candidate;
    }
  }
  return undefined;
}

function loadCompatibilityBase() {
  const sha = resolveCompatibilityBaseSha();
  if (sha === undefined) return { sha: undefined, baseline: undefined };
  git(["cat-file", "-e", `${sha}^{commit}`]);
  const source = git(["show", `${sha}:config/compatibility-facts.baseline.json`], {
    allowFailure: true,
  });
  return { sha, baseline: source === undefined ? undefined : JSON.parse(source) };
}

export function checkCompatibilityFacts(policy, options = {}) {
  const current = generateCompatibilityFacts(policy);
  if (!existsSync(BASELINE_PATH)) throw new Error("缺少checked-in compatibility facts baseline");
  const checkedInBaseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const compatibilityBase = loadCompatibilityBase();
  assertCompatibilityFactsBaselineChain(compatibilityBase.baseline, checkedInBaseline, current);
  if (options.quiet !== true) {
    console.log(`compatibility facts有效：${String(current.domains.length)}个真实Owner域`);
    if (compatibilityBase.sha !== undefined) {
      console.log(`compatibility facts base：${compatibilityBase.sha}`);
    }
  }
  return current;
}

export function updateCompatibilityFactsBaseline(policy) {
  writeFileSync(BASELINE_PATH, json(generateCompatibilityFacts(policy)), "utf8");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const command = process.argv[2] ?? "generate";
  if (command === "generate") process.stdout.write(json(generateCompatibilityFacts(policy)));
  else if (command === "update-baseline") {
    updateCompatibilityFactsBaseline(policy);
    console.log("compatibility facts baseline已更新");
  } else if (command === "check") checkCompatibilityFacts(policy);
  else throw new Error(`未知compatibility facts命令：${command}`);
}
