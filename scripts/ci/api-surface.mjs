import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = join(ROOT, "config/api-surface.baseline.json");
const WAIVER_PATH = join(ROOT, "config/api-breaking-change-waivers.json");
const CONTRACTS_ROOT = join(ROOT, "packages/contracts/src");
const APPLICATION_ROOT = join(ROOT, "packages/application/src");
const FORBIDDEN_PUBLIC_NAME =
  /(?:HookToken|WorkflowRunId|Pi(?:Runtime)?SessionId|RuntimeCredential|ProviderCredential|ApiKey)/u;
const FORBIDDEN_MANIFEST_TEXT =
  /(?:\/internal\/runtime|runtime-credential|hookToken|workflowRunId|piRuntimeSessionId|apiKey|promptText)/u;

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

function sourceFile(path) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function literalText(node) {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    ? node.text
    : node.kind === ts.SyntaxKind.TrueKeyword
      ? "true"
      : node.kind === ts.SyntaxKind.FalseKeyword
        ? "false"
        : undefined;
}

function resolvedLiteralText(checker, node, seen = new Set()) {
  const direct = literalText(node);
  if (direct !== undefined) return direct;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return resolvedLiteralText(checker, node.expression, seen);
  }
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  const actual = resolvedSymbol(checker, symbol);
  if (seen.has(actual)) return undefined;
  seen.add(actual);
  for (const declaration of actual.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const value = resolvedLiteralText(checker, declaration.initializer, seen);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function schemaReference(name, schemas) {
  const schema = schemas.get(name);
  return {
    identity: name,
    schemaVersions: schema?.schemaVersions ?? [],
    signatureSha256: schema?.signatureSha256 ?? sha256(`unresolved-schema:${name}`),
  };
}

function routeSchemas(handler, responseOnly = false) {
  const names = new Set();
  visit(handler, (node) => {
    if (!ts.isIdentifier(node) || !node.text.endsWith("Schema")) return;
    let current = node;
    let inReturn = false;
    while (current.parent !== undefined && current !== handler) {
      if (ts.isReturnStatement(current.parent)) inReturn = true;
      current = current.parent;
    }
    if (responseOnly === inReturn) names.add(node.text);
  });
  return [...names].sort();
}

function importedApplicationOperations(file) {
  const names = new Set();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@chat/application" ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (!["ApplicationError", "notFound"].includes(element.name.text))
        names.add(element.name.text);
    }
  }
  return names;
}

function operationsInHandler(handler, imported) {
  const operations = new Set();
  visit(handler, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      imported.has(node.expression.text)
    ) {
      operations.add(node.expression.text);
    }
  });
  return [...operations].sort();
}

function applicationOperationContract(program, checker, operation) {
  const responseSchemas = new Set();
  let callable;
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(APPLICATION_ROOT)) continue;
    visit(file, (node) => {
      const isFunction = ts.isFunctionDeclaration(node) && node.name?.text === operation;
      const isVariable =
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === operation &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
      if (!isFunction && !isVariable) return;
      if (callable !== undefined)
        throw new Error(`Application operation存在重复声明：${operation}`);
      callable = isVariable ? node.initializer : node;
      visit(callable, (nested) => {
        if (ts.isIdentifier(nested) && nested.text.endsWith("ResponseSchema")) {
          responseSchemas.add(nested.text);
        }
      });
    });
  }
  if (callable === undefined) {
    throw new Error(`无法从@chat/application真实源码解析operation：${operation}`);
  }
  const signature = checker.getSignatureFromDeclaration(callable);
  if (signature === undefined) {
    throw new Error(`无法解析Application operation返回签名：${operation}`);
  }
  const awaited = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
  const returnType = checker.typeToString(
    awaited,
    callable,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
      ts.TypeFormatFlags.WriteArrayAsGenericType,
  );
  const returnExpressions = [];
  visit(callable.body ?? callable, (nested) => {
    if (ts.isReturnStatement(nested) && nested.expression !== undefined) {
      returnExpressions.push(normalizedDeclaration(nested.expression));
    }
  });
  return {
    responseSchemas: [...responseSchemas].sort(),
    fallback: {
      identity: `application-result:${operation}`,
      schemaVersions: [],
      // 并非所有历史用例都有显式ResponseSchema。返回类型和return表达式的摘要让推断
      // 类型/包装对象变化进入compat diff，同时不把内部类型或实现正文写进公共Manifest。
      signatureSha256: sha256(
        JSON.stringify({ returnType, returnExpressions: returnExpressions.sort() }),
      ),
    },
  };
}

function parseProgram() {
  // API tsconfig是公开组合根；显式加入Contracts和Application public barrel，确保
  // response fallback不是手抄名称，而是来自真实Application返回签名。
  const configPath = join(ROOT, "apps/api/tsconfig.json");
  if (!existsSync(configPath)) throw new Error("缺少API tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  return ts.createProgram({
    rootNames: [
      ...new Set([
        ...parsed.fileNames,
        join(CONTRACTS_ROOT, "public.ts"),
        join(APPLICATION_ROOT, "index.ts"),
      ]),
    ],
    options: parsed.options,
  });
}

function productRouteFiles() {
  const composition = sourceFile(join(ROOT, "apps/api/src/product-routes.ts"));
  const imported = new Map();
  for (const statement of composition.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith("./product-routes/") ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    const path = resolve(
      dirname(composition.fileName),
      statement.moduleSpecifier.text.replace(/\.js$/u, ".ts"),
    );
    for (const element of statement.importClause.namedBindings.elements) {
      imported.set(element.name.text, path);
    }
  }
  const used = new Set();
  visit(composition, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const path = imported.get(node.expression.text);
      if (path !== undefined) used.add(path);
    }
  });
  if (used.size === 0) throw new Error("公开Product Router组合根未注册任何路由族");
  return [...used].sort();
}

function collectRoutes(program, schemas) {
  const checker = program.getTypeChecker();
  const routes = [];
  const app = sourceFile(join(ROOT, "apps/api/src/app.ts"));
  let productMounted = false;
  visit(app, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text.toUpperCase();
    const path = node.arguments[0];
    if (method === "ROUTE" && ts.isStringLiteral(path) && path.text === "/api") {
      const mount = node.arguments[1];
      productMounted =
        mount !== undefined &&
        ts.isCallExpression(mount) &&
        ts.isIdentifier(mount.expression) &&
        mount.expression.text === "createProductRouter";
    }
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
    if (!ts.isStringLiteral(path) || !path.text.startsWith("/api/")) return;
    const handler = node.arguments.at(-1);
    if (handler === undefined) throw new Error(`公开路由缺少handler：${method} ${path.text}`);
    routes.push({
      method,
      path: path.text,
      kind: method === "GET" ? "query" : "command",
      requestSchemas: [],
      responseSchemas: [
        {
          identity: `inline-response:${method} ${path.text}`,
          schemaVersions: [],
          signatureSha256: sha256(normalizedDeclaration(handler)),
        },
      ],
      applicationOperations: [],
    });
  });
  if (!productMounted) throw new Error("apps/api组合根未把createProductRouter挂载到/api");

  for (const path of productRouteFiles()) {
    const file = sourceFile(path);
    const imported = importedApplicationOperations(file);
    visit(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
      const routePath = node.arguments[0];
      const handler = node.arguments.at(-1);
      if (!ts.isStringLiteral(routePath) || handler === undefined) return;
      if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
      const operations = operationsInHandler(handler, imported);
      const requestNames = routeSchemas(handler, false);
      const explicitResponseNames = routeSchemas(handler, true);
      const derivedResponseNames = new Set(explicitResponseNames);
      const operationContracts = operations.map((operation) =>
        applicationOperationContract(program, checker, operation),
      );
      for (const contract of operationContracts) {
        for (const response of contract.responseSchemas) {
          derivedResponseNames.add(response);
        }
      }
      routes.push({
        method,
        path: `/api${routePath.text}`,
        kind: method === "GET" ? "query" : "command",
        requestSchemas: requestNames.map((name) => schemaReference(name, schemas)),
        responseSchemas:
          derivedResponseNames.size > 0
            ? [...derivedResponseNames].sort().map((name) => schemaReference(name, schemas))
            : operationContracts.length > 0
              ? operationContracts.map((contract) => contract.fallback)
              : [
                  {
                    identity: `inline-response:${method} /api${routePath.text}`,
                    schemaVersions: [],
                    signatureSha256: sha256(normalizedDeclaration(handler)),
                  },
                ],
        applicationOperations: operations,
      });
    });
  }
  const seen = new Set();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`公开路由重复：${key}`);
    seen.add(key);
  }
  return routes.sort((left, right) =>
    `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`),
  );
}

function normalizedDeclaration(declaration) {
  const printer = ts.createPrinter({ removeComments: true });
  return printer
    .printNode(ts.EmitHint.Unspecified, declaration, declaration.getSourceFile())
    .replace(/\s+/gu, " ")
    .trim();
}

function resolvedSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationClosure(checker, declaration, collected = new Set(), visiting = new Set()) {
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}:${String(declaration.end)}`;
  if (visiting.has(key)) return collected;
  visiting.add(key);
  collected.add(normalizedDeclaration(declaration));
  visit(declaration, (node) => {
    if (!ts.isIdentifier(node)) return;
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return;
    const actual = resolvedSymbol(checker, symbol);
    for (const nested of actual.declarations ?? []) {
      if (!nested.getSourceFile().fileName.startsWith(CONTRACTS_ROOT)) continue;
      if (
        ts.isVariableDeclaration(nested) ||
        ts.isTypeAliasDeclaration(nested) ||
        ts.isInterfaceDeclaration(nested) ||
        ts.isEnumDeclaration(nested)
      ) {
        declarationClosure(checker, nested, collected, visiting);
      }
    }
  });
  visiting.delete(key);
  return collected;
}

function isOptionalSchemaExpression(node) {
  let optional = false;
  visit(node, (nested) => {
    if (
      ts.isCallExpression(nested) &&
      ts.isPropertyAccessExpression(nested.expression) &&
      nested.expression.name.text === "optional"
    )
      optional = true;
  });
  return optional;
}

function schemaFacts(checker, declarations) {
  const requiredFields = new Set();
  const enumValues = new Set();
  const schemaVersions = new Set();
  for (const declaration of declarations) {
    visit(declaration, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const call = node.expression.name.text;
      if (
        call === "enum" &&
        node.arguments[0] !== undefined &&
        ts.isArrayLiteralExpression(node.arguments[0])
      ) {
        for (const element of node.arguments[0].elements) {
          const value = literalText(element);
          if (value !== undefined) enumValues.add(value);
        }
      }
      if (
        call !== "object" ||
        node.arguments[0] === undefined ||
        !ts.isObjectLiteralExpression(node.arguments[0])
      )
        return;
      for (const property of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name.getText().replace(/^['"]|['"]$/gu, "");
        if (!isOptionalSchemaExpression(property.initializer)) requiredFields.add(name);
        if (name !== "schemaVersion") continue;
        visit(property.initializer, (nested) => {
          if (
            ts.isCallExpression(nested) &&
            ts.isPropertyAccessExpression(nested.expression) &&
            nested.expression.name.text === "literal" &&
            nested.arguments[0] !== undefined
          ) {
            const value = resolvedLiteralText(checker, nested.arguments[0]);
            if (value !== undefined) schemaVersions.add(value);
          }
        });
      }
    });
  }
  return {
    requiredFields: [...requiredFields].sort(),
    enumValues: [...enumValues].sort(),
    schemaVersions: [...schemaVersions].sort(),
  };
}

function publicContracts(program) {
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(join(CONTRACTS_ROOT, "public.ts"));
  if (entry === undefined) throw new Error("缺少@chat/contracts/public真实入口");
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (moduleSymbol === undefined) throw new Error("无法解析@chat/contracts/public导出");
  const symbols = [];
  const schemas = new Map();
  const deprecated = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    if (FORBIDDEN_PUBLIC_NAME.test(name)) continue;
    const actual = resolvedSymbol(checker, exported);
    const declarations = (actual.declarations ?? []).filter((declaration) =>
      declaration.getSourceFile().fileName.startsWith(CONTRACTS_ROOT),
    );
    if (declarations.length === 0) continue;
    const closure = new Set();
    for (const declaration of declarations) declarationClosure(checker, declaration, closure);
    const signatureSha256 = sha256([...closure].sort().join("\n"));
    const schema = name.endsWith("Schema");
    const kind = schema
      ? "schema"
      : name.includes("Command")
        ? "command-type"
        : name.includes("Query")
          ? "query-type"
          : name.includes("Event")
            ? "event-type"
            : actual.flags & ts.SymbolFlags.Type
              ? "type"
              : "value";
    symbols.push({ name, kind, signatureSha256 });
    if (schema) {
      const facts = schemaFacts(checker, declarations);
      const descriptor = { name, signatureSha256, ...facts };
      schemas.set(name, descriptor);
    }
    for (const declaration of declarations) {
      for (const tag of ts.getJSDocTags(declaration)) {
        if (tag.tagName.text !== "deprecated") continue;
        const condition = typeof tag.comment === "string" ? tag.comment.trim() : "";
        if (condition === "") throw new Error(`@deprecated ${name}缺少移除条件`);
        deprecated.push({ symbol: name, removalCondition: condition });
      }
    }
  }
  symbols.sort((left, right) => left.name.localeCompare(right.name));
  deprecated.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { symbols, schemas, deprecated };
}

function packageExports() {
  const packages = [];
  for (const parent of [join(ROOT, "apps"), join(ROOT, "packages")]) {
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const entries = [];
      if (typeof manifest.exports === "string") entries.push(".");
      else if (manifest.exports !== null && typeof manifest.exports === "object") {
        for (const key of Object.keys(manifest.exports)) {
          const serialized = JSON.stringify(manifest.exports[key]);
          if (/runtime-credential|internal-credential/u.test(`${key}:${serialized}`)) continue;
          entries.push(key);
        }
      }
      packages.push({
        name: manifest.name,
        exportPaths: entries.sort(),
        executableCommands: Object.keys(manifest.bin ?? {}).sort(),
      });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function generateApiSurface() {
  const program = parseProgram();
  const contracts = publicContracts(program);
  const routes = collectRoutes(program, contracts.schemas);
  const problem = contracts.schemas.get("problemCodeSchema");
  const recovery = contracts.schemas.get("recoveryActionSchema");
  const manifest = {
    schemaVersion: "chat-public-api-surface.v1",
    generation: {
      apiCompositionRoot: "apps/api:createApiApp",
      browserContractEntry: "@chat/contracts/public",
      packageExportSource: "workspace-package-manifests",
    },
    routes,
    commandTypes: contracts.symbols
      .filter((entry) => entry.kind === "command-type")
      .map((entry) => entry.name),
    queryTypes: contracts.symbols
      .filter((entry) => entry.kind === "query-type")
      .map((entry) => entry.name),
    publicSchemas: [...contracts.schemas.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    versionedDtoAndEventSchemas: [...contracts.schemas.values()]
      .filter((entry) => entry.schemaVersions.length > 0)
      .map((entry) => ({ identity: entry.name, schemaVersions: entry.schemaVersions }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
    problems: {
      codes: problem?.enumValues ?? [],
      recoveryActions: recovery?.enumValues ?? [],
    },
    packageExports: packageExports(),
    publicSymbols: contracts.symbols,
    deprecated: contracts.deprecated,
  };
  const rendered = json(manifest);
  if (FORBIDDEN_MANIFEST_TEXT.test(rendered)) {
    throw new Error("API Surface包含私有Runtime身份、凭据或Prompt字段");
  }
  return stable(manifest);
}

function issue(kind, target, detail = {}) {
  return { issueId: `${kind}:${target}`, kind, target, ...detail };
}

function mapBy(items, key) {
  return new Map(items.map((item) => [key(item), item]));
}

export function diffApiSurface(baseline, current) {
  const issues = [];
  const previousRoutes = mapBy(baseline.routes, (route) => `${route.method} ${route.path}`);
  const currentRoutes = mapBy(current.routes, (route) => `${route.method} ${route.path}`);
  for (const [key, route] of previousRoutes) {
    const next = currentRoutes.get(key);
    if (next === undefined) issues.push(issue("route_removed", key));
    else if (
      JSON.stringify(route.requestSchemas) !== JSON.stringify(next.requestSchemas) ||
      JSON.stringify(route.responseSchemas) !== JSON.stringify(next.responseSchemas)
    ) {
      issues.push(issue("route_contract_changed", key));
    }
  }

  const previousPackages = mapBy(baseline.packageExports, (entry) => entry.name);
  const currentPackages = mapBy(current.packageExports, (entry) => entry.name);
  for (const [name, entry] of previousPackages) {
    const next = currentPackages.get(name);
    for (const exportPath of entry.exportPaths) {
      if (next === undefined || !next.exportPaths.includes(exportPath)) {
        issues.push(issue("package_export_removed", `${name}:${exportPath}`));
      }
    }
  }

  const previousSymbols = mapBy(baseline.publicSymbols, (entry) => entry.name);
  const currentSymbols = mapBy(current.publicSymbols, (entry) => entry.name);
  for (const [name, symbol] of previousSymbols) {
    const next = currentSymbols.get(name);
    if (next === undefined) issues.push(issue("public_symbol_removed", name));
    else if (symbol.kind !== "schema" && symbol.signatureSha256 !== next.signatureSha256) {
      issues.push(
        issue("public_symbol_changed", name, {
          before: symbol.signatureSha256,
          after: next.signatureSha256,
        }),
      );
    }
  }

  const previousSchemas = mapBy(baseline.publicSchemas, (entry) => entry.name);
  const currentSchemas = mapBy(current.publicSchemas, (entry) => entry.name);
  for (const [name, schema] of previousSchemas) {
    const next = currentSchemas.get(name);
    if (next === undefined) {
      issues.push(issue("schema_removed", name));
      continue;
    }
    for (const field of next.requiredFields.filter(
      (field) => !schema.requiredFields.includes(field),
    )) {
      issues.push(issue("required_field_added", `${name}.${field}`));
    }
    for (const value of schema.enumValues.filter((value) => !next.enumValues.includes(value))) {
      issues.push(issue("enum_narrowed", `${name}:${value}`));
    }
    if (schema.signatureSha256 !== next.signatureSha256) {
      const sameGeneration =
        JSON.stringify(schema.schemaVersions) === JSON.stringify(next.schemaVersions);
      issues.push(
        issue(sameGeneration ? "same_schema_literal_changed" : "schema_generation_changed", name, {
          before: schema.signatureSha256,
          after: next.signatureSha256,
        }),
      );
    }
  }
  if (JSON.stringify(baseline.problems.codes) !== JSON.stringify(current.problems.codes)) {
    issues.push(issue("problem_codes_changed", "ProblemCode"));
  }
  if (
    JSON.stringify(baseline.problems.recoveryActions) !==
    JSON.stringify(current.problems.recoveryActions)
  ) {
    issues.push(issue("recovery_actions_changed", "RecoveryAction"));
  }
  return issues.sort((left, right) => left.issueId.localeCompare(right.issueId));
}

export function validateWaivers(value) {
  if (value === null || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("breaking change waiver必须是schemaVersion=1的对象");
  }
  if (!Array.isArray(value.waivers)) throw new Error("breaking change waiver列表缺失");
  const seen = new Set();
  for (const waiver of value.waivers) {
    for (const field of [
      "issueId",
      "approvedBy",
      "approvalReference",
      "detect",
      "why",
      "fix",
      "verify",
      "rollback",
    ]) {
      if (typeof waiver?.[field] !== "string" || waiver[field].trim() === "") {
        throw new Error(`breaking change waiver缺少${field}`);
      }
    }
    if (!waiver.approvedBy.startsWith("user:")) {
      throw new Error("breaking change waiver必须记录明确用户批准（approvedBy=user:...）");
    }
    if (seen.has(waiver.issueId)) throw new Error(`重复breaking change waiver：${waiver.issueId}`);
    seen.add(waiver.issueId);
  }
  return value.waivers;
}

export function assertApiSurfaceCompatible(baseline, current, waiverDocument) {
  const issues = diffApiSurface(baseline, current);
  const waivers = validateWaivers(waiverDocument);
  const waiverIds = new Set(waivers.map((waiver) => waiver.issueId));
  const missing = issues.filter((entry) => !waiverIds.has(entry.issueId));
  const stale = waivers.filter(
    (waiver) => !issues.some((entry) => entry.issueId === waiver.issueId),
  );
  if (stale.length > 0)
    throw new Error(`存在过期breaking change waiver：${stale.map((w) => w.issueId).join(", ")}`);
  if (missing.length > 0) {
    throw new Error(
      `API Surface存在未获用户明确批准的breaking change：\n${missing
        .map((entry) => `- ${entry.issueId}`)
        .join("\n")}`,
    );
  }
  return issues;
}

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(`git ${args.join(" ")}失败：${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function resolveCompatibilityBaseSha() {
  const explicit = process.env.CHAT_API_SURFACE_BASE_SHA?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!/^[0-9a-f]{40}$/u.test(explicit)) {
      throw new Error("CHAT_API_SURFACE_BASE_SHA必须是完整40位commit");
    }
    if (/^0{40}$/u.test(explicit)) return undefined;
    return explicit;
  }
  // 多worktree场景的本地main通常比未fetch的origin/main新；Hosted CI由上面的显式SHA决定。
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
  const source = git(["show", `${sha}:config/api-surface.baseline.json`], {
    allowFailure: true,
  });
  // 首次建立机器基线时，main本来没有该文件；这是唯一允许没有base baseline的情形。
  return {
    sha,
    baseline: source === undefined ? undefined : JSON.parse(source),
  };
}

export function assertApiSurfaceBaselineChain(
  baseBaseline,
  checkedInBaseline,
  current,
  waiverDocument,
) {
  if (json(checkedInBaseline) !== json(current)) {
    throw new Error("API Surface生成结果与checked-in baseline漂移；必须先审查并更新baseline");
  }
  if (baseBaseline === undefined) {
    const waivers = validateWaivers(waiverDocument);
    if (waivers.length > 0) throw new Error("没有base baseline时不得保留breaking change waiver");
    return [];
  }
  return assertApiSurfaceCompatible(baseBaseline, current, waiverDocument);
}

function readableDiff(issues) {
  return issues.length === 0
    ? "API Surface与checked-in baseline一致。\n"
    : `API Surface breaking diff（${String(issues.length)}）：\n${issues
        .map((entry) => `- ${entry.issueId}`)
        .join("\n")}\n`;
}

async function main() {
  const command = process.argv[2] ?? "check";
  const current = generateApiSurface();
  if (command === "generate") {
    process.stdout.write(json(current));
    return;
  }
  if (command === "update-baseline") {
    writeFileSync(BASELINE_PATH, json(current), "utf8");
    console.log(`API Surface baseline已更新：${relative(ROOT, BASELINE_PATH)}`);
    return;
  }
  if (!existsSync(BASELINE_PATH)) throw new Error("缺少checked-in API Surface baseline");
  const checkedInBaseline = load(BASELINE_PATH);
  const compatibilityBase = loadCompatibilityBase();
  const comparisonBaseline = compatibilityBase.baseline ?? checkedInBaseline;
  const issues = diffApiSurface(comparisonBaseline, current);
  if (command === "diff") {
    if (compatibilityBase.sha !== undefined) {
      process.stdout.write(`API Surface compatibility base：${compatibilityBase.sha}\n`);
    }
    process.stdout.write(readableDiff(issues));
    return;
  }
  if (command !== "check") throw new Error(`未知API Surface命令：${command}`);
  assertApiSurfaceBaselineChain(
    compatibilityBase.baseline,
    checkedInBaseline,
    current,
    load(WAIVER_PATH),
  );
  if (compatibilityBase.sha !== undefined) {
    process.stdout.write(`API Surface compatibility base：${compatibilityBase.sha}\n`);
  }
  process.stdout.write(readableDiff(issues));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
