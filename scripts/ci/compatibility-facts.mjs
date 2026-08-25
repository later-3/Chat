import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = resolve(ROOT, "config/compatibility-policy.json");
const BASELINE_PATH = resolve(ROOT, "config/compatibility-facts.baseline.json");
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

function declarationClosure(checker, declaration, roots, output = new Set(), seen = new Set()) {
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}:${String(declaration.end)}`;
  if (seen.has(key)) return output;
  seen.add(key);
  output.add(`${relative(ROOT, declaration.getSourceFile().fileName)}:${normalized(declaration)}`);
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
        declarationClosure(checker, nested, roots, output, seen);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, visit);
  return output;
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

function generationRecord(identity, evidence) {
  return {
    identity,
    family: identity.replace(/v\d+$/u, ""),
    generation: Number(/v(\d+)$/u.exec(identity)?.[1]),
    canonicalSha256: sha256([...evidence].sort().join("\n")),
    evidenceCount: evidence.size,
  };
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

function productStoreFacts(domain, files) {
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
            const target = directVersions(
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
      evidence.add(`reader:${normalized(open)}`);
      for (const migration of migrations.filter(
        (entry) => entry.source === identity || entry.target === identity,
      )) {
        evidence.add(`migration:${normalized(migration.declaration)}`);
      }
      if (currentWriteGenerations.includes(identity)) {
        evidence.add(`writer:${normalized(transact)}`);
        evidence.add(`persist:${normalized(persist)}`);
      }
      return generationRecord(identity, evidence);
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
      compatibilityEntries: migrations.map((entry) => ({
        entry: `${relative(ROOT, entry.declaration.getSourceFile().fileName)}:${entry.declaration.name.text}`,
        generations: [entry.source, entry.target],
        evidenceKind: "resolved-call-input-output",
        canonicalSha256: sha256(normalized(entry.declaration)),
      })),
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
      evidence.add(`reader-migration:${normalized(load)}`);
      if (currentWriteGenerations.includes(identity)) evidence.add(`writer:${normalized(write)}`);
      return generationRecord(identity, evidence);
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
    },
  );
}

function rootedDomainFacts(domain, files) {
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
      entries.push(declaration);
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
  const generations = [...versionSchemas]
    .map(([identity, rootsForVersion]) => {
      const evidence = new Set(validatorEvidence.map((value) => `validator:${value}`));
      for (const schema of rootsForVersion) declarationClosure(checker, schema, roots, evidence);
      if (currentWriteGenerations.includes(identity))
        evidence.add(`writer:${normalized(writerEntry)}`);
      return generationRecord(identity, evidence);
    })
    .sort((left, right) =>
      left.identity.localeCompare(right.identity, undefined, { numeric: true }),
    );
  const historicalReadableGenerations = generations
    .map((entry) => entry.identity)
    .filter((identity) => !currentWriteGenerations.includes(identity));
  return domainFacts(
    domain,
    [...files, ...extras],
    generations,
    currentWriteGenerations,
    historicalReadableGenerations,
    {
      legacyAuthority: authority(
        `${domain.id}:reader-validator`,
        historicalReadableGenerations,
        ["parse", "validate"],
        schemas.map((schema) => schema.declaration ?? schema),
      ),
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
  return {
    id: domain.id,
    sourceFiles: [
      ...new Set(files.map((path) => relative(ROOT, path).split(sep).join("/"))),
    ].sort(),
    generations,
    currentWriteGenerations: [...currentWriteGenerations].sort(),
    historicalReadableGenerations: [...historicalReadableGenerations].sort(),
    compatibilityEntries: evidence.compatibilityEntries.sort((left, right) =>
      left.entry.localeCompare(right.entry),
    ),
    legacyAuthority,
    writeAuthority,
    authorityBoundarySha256: sha256(
      json({ id: domain.id, owners: domain.ownerRoots, legacyAuthority, writeAuthority }),
    ),
  };
}

function apiGenerations() {
  const api = JSON.parse(readFileSync(resolve(ROOT, "config/api-surface.baseline.json"), "utf8"));
  // Browser只消费@chat/contracts/public；以该真实public entry生成的DTO/Event全集为上界，
  // 比手抄“浏览器可能用到的名称”更严格，也不会把内部Runtime合同带入事实集。
  const schemas = api.publicSchemas;
  const evidence = new Map();
  for (const schema of schemas) {
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
    const authorityEvidence = files.map((path) =>
      path.endsWith(".json")
        ? `api-surface:${json(api)}`
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
    if (!extractorUpgrade && next.authorityBoundarySha256 !== previous.authorityBoundarySha256) {
      throw new Error(`${previous.id}事实Owner边界漂移`);
    }
    const generations = new Map(next.generations.map((entry) => [entry.identity, entry]));
    for (const generation of previous.generations) {
      const candidate = generations.get(generation.identity);
      if (candidate === undefined)
        throw new Error(`${previous.id}删除历史代际：${generation.identity}`);
      if (!extractorUpgrade && candidate.canonicalSha256 !== generation.canonicalSha256) {
        throw new Error(`${previous.id}同一schema literal原地语义漂移：${generation.identity}`);
      }
    }
    for (const currentIdentity of previous.currentWriteGenerations) {
      if (!next.currentWriteGenerations.includes(currentIdentity)) {
        const prior = previous.generations.find((entry) => entry.identity === currentIdentity);
        const replacement = next.generations.find(
          (entry) => entry.family === prior?.family && entry.generation > (prior?.generation ?? 0),
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

function assertDomainFactsWellFormed(domain) {
  const generations = new Map(domain.generations.map((entry) => [entry.identity, entry]));
  if (generations.size !== domain.generations.length) throw new Error(`${domain.id}代际重复`);
  for (const entry of domain.generations) {
    if (!/^[0-9a-f]{64}$/u.test(entry.canonicalSha256) || entry.evidenceCount < 1) {
      throw new Error(`${domain.id}:${entry.identity}缺少真实合同闭包证据`);
    }
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
  for (const identity of [
    ...domain.currentWriteGenerations,
    ...domain.historicalReadableGenerations,
  ]) {
    if (!generations.has(identity)) {
      throw new Error(`${domain.id}删除历史代际或authority引用未知代际：${identity}`);
    }
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
