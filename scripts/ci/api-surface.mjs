import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = join(ROOT, "config/api-surface.baseline.json");
const WAIVER_PATH = join(ROOT, "config/api-breaking-change-waivers.json");
const CHANGE_RECORD_PATH = join(ROOT, "config/api-compatible-change-records.json");
const CONTRACTS_ROOT = join(ROOT, "packages/contracts/src");
const FORBIDDEN_PUBLIC_NAME =
  /(?:HookToken|WorkflowRunId|Pi(?:Runtime)?SessionId|RuntimeCredential|ProviderCredential|ApiKey)/u;
const FORBIDDEN_PUBLIC_IDENTITY =
  /(?:hookToken|workflowRunId|pi(?:Runtime)?SessionId|runtimeCredential|providerCredential|apiKey)/iu;
const FORBIDDEN_MANIFEST_TEXT =
  /(?:\/internal\/runtime|hookToken|workflowRunId|piRuntimeSessionId|apiKey|promptText)/u;

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

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
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
  if (schema === undefined) {
    throw new Error(`公开路由引用了无法从Contracts源码解析的Schema：${name}`);
  }
  return {
    identity: name,
    schemaVersions: schema.schemaVersions,
    signatureSha256: schema.signatureSha256,
  };
}

function variableInitializers(handler) {
  const values = new Map();
  visit(handler, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      values.set(node.name.text, node.initializer);
    }
  });
  return values;
}

function requestSourceKinds(node, initializers, seen = new Set()) {
  const kinds = new Set();
  visit(node, (nested) => {
    if (
      ts.isCallExpression(nested) &&
      ts.isPropertyAccessExpression(nested.expression) &&
      nested.expression.name.text === "param" &&
      ts.isPropertyAccessExpression(nested.expression.expression) &&
      nested.expression.expression.name.text === "req"
    ) {
      kinds.add("path");
    }
    if (
      ts.isCallExpression(nested) &&
      ts.isIdentifier(nested.expression) &&
      nested.expression.text === "parseJsonBody"
    ) {
      kinds.add("body");
    }
    if (
      ts.isPropertyAccessExpression(nested) &&
      nested.name.text === "url" &&
      ts.isPropertyAccessExpression(nested.expression) &&
      nested.expression.name.text === "req"
    ) {
      kinds.add("query");
    }
    if (
      ts.isCallExpression(nested) &&
      ts.isPropertyAccessExpression(nested.expression) &&
      ["get", "getAll", "has"].includes(nested.expression.name.text) &&
      ts.isIdentifier(nested.expression.expression) &&
      /(?:params|query)/iu.test(nested.expression.expression.text)
    ) {
      kinds.add("query");
    }
    if (ts.isIdentifier(nested) && initializers.has(nested.text) && !seen.has(nested.text)) {
      seen.add(nested.text);
      for (const kind of requestSourceKinds(initializers.get(nested.text), initializers, seen)) {
        kinds.add(kind);
      }
    }
  });
  return kinds;
}

function schemaParse(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "parse" ||
    !ts.isIdentifier(node.expression.expression) ||
    !node.expression.expression.text.endsWith("Schema")
  ) {
    return undefined;
  }
  return { name: node.expression.expression.text, input: node.arguments[0] };
}

function pathParameterNames(node) {
  const names = new Set();
  visit(node, (nested) => {
    if (
      ts.isCallExpression(nested) &&
      ts.isPropertyAccessExpression(nested.expression) &&
      nested.expression.name.text === "param" &&
      nested.arguments[0] !== undefined &&
      ts.isStringLiteralLike(nested.arguments[0])
    ) {
      names.add(nested.arguments[0].text);
    }
  });
  return [...names].sort();
}

function declarationCallClosure(checker, declaration, output = new Set(), seen = new Set()) {
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}`;
  if (seen.has(key)) return output;
  seen.add(key);
  output.add(normalizedDeclaration(declaration));
  visit(declaration, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol === undefined) return;
    for (const nested of resolvedSymbol(checker, symbol).declarations ?? []) {
      if (!nested.getSourceFile().fileName.includes("/apps/api/src/product-routes/")) continue;
      if (
        ts.isFunctionDeclaration(nested) ||
        (ts.isVariableDeclaration(nested) && nested.initializer !== undefined)
      ) {
        declarationCallClosure(checker, nested, output, seen);
      }
    }
  });
  return output;
}

function declarationNodeClosure(checker, declaration, output = new Set(), seen = new Set()) {
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}`;
  if (seen.has(key)) return output;
  seen.add(key);
  output.add(declaration);
  visit(declaration, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol === undefined) return;
    for (const nested of resolvedSymbol(checker, symbol).declarations ?? []) {
      if (!nested.getSourceFile().fileName.includes("/apps/api/src/product-routes/")) continue;
      declarationNodeClosure(checker, nested, output, seen);
    }
  });
  return output;
}

function allowedQueryKeys(declarations) {
  const keys = new Set();
  for (const declaration of declarations) {
    visit(declaration, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["get", "getAll", "has"].includes(node.expression.name.text) &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        keys.add(node.arguments[0].text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "assertOnlyAllowedQueryKeys"
      ) {
        const list = node.arguments[1];
        if (list !== undefined && ts.isArrayLiteralExpression(list)) {
          for (const element of list.elements) {
            if (ts.isStringLiteralLike(element)) keys.add(element.text);
          }
        }
      }
    });
  }
  return [...keys].sort();
}

function queryParserContracts(handler, checker, initializers, schemas) {
  if (!requestSourceKinds(handler, initializers).has("query")) return [];
  const declarations = new Set();
  const queryExpressions = new Set();
  visit(handler, (node) => {
    if (!ts.isCallExpression(node)) return;
    const parsed = schemaParse(node);
    const directQuery = requestSourceKinds(node, initializers).has("query");
    if (directQuery && parsed !== undefined) {
      queryExpressions.add(normalizedDeclaration(node));
    }
    if (!ts.isIdentifier(node.expression)) return;
    if (!node.arguments.some((argument) => requestSourceKinds(argument, initializers).has("query")))
      return;
    queryExpressions.add(normalizedDeclaration(node));
    const symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol === undefined) return;
    for (const declaration of resolvedSymbol(checker, symbol).declarations ?? []) {
      if (declaration.getSourceFile().fileName.includes("/apps/api/src/product-routes/")) {
        declarations.add(declaration);
      }
    }
  });
  const closure = new Set(queryExpressions);
  const closureNodes = new Set();
  for (const declaration of declarations) {
    declarationCallClosure(checker, declaration, closure);
    declarationNodeClosure(checker, declaration, closureNodes);
  }
  const schemaNames = new Set();
  for (const declaration of closureNodes) {
    visit(declaration, (node) => {
      const parsed = schemaParse(node);
      if (parsed !== undefined) schemaNames.add(parsed.name);
    });
  }
  if (closure.size === 0) return [];
  return [
    {
      identity: `query-parser:${handler.getSourceFile().fileName.split("/").at(-1)}`,
      allowedKeys: allowedQueryKeys(closureNodes),
      schemas: [...schemaNames].sort().map((name) => schemaReference(name, schemas)),
      signatureSha256: sha256([...closure].sort().join("\n")),
    },
  ];
}

function routeContract(handler, checker, schemas) {
  const initializers = variableInitializers(handler);
  const pathParameters = [];
  const querySchemas = new Set();
  const bodySchemas = new Set();
  const responseSchemaNames = new Set();
  visit(handler, (node) => {
    const parsed = schemaParse(node);
    if (parsed === undefined || parsed.input === undefined) return;
    const kinds = requestSourceKinds(parsed.input, initializers);
    if (kinds.has("path")) {
      for (const name of pathParameterNames(parsed.input)) {
        pathParameters.push({ name, schema: schemaReference(parsed.name, schemas) });
      }
    }
    if (kinds.has("query")) querySchemas.add(parsed.name);
    if (kinds.has("body")) bodySchemas.add(parsed.name);
  });

  const successfulResponses = [];
  visit(handler, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "json" ||
      node.arguments[0] === undefined
    ) {
      return;
    }
    const expression = node.arguments[0];
    const explicit = new Set();
    visit(expression, (nested) => {
      const parsed = schemaParse(nested);
      if (parsed === undefined || parsed.input === undefined) return;
      if (requestSourceKinds(parsed.input, initializers).size === 0) explicit.add(parsed.name);
    });
    for (const name of explicit) responseSchemaNames.add(name);
    const type = observableTypeString(checker, expression, "公开成功响应");
    successfulResponses.push({
      source: "json",
      status:
        node.arguments[1] === undefined
          ? "default"
          : (resolvedLiteralText(checker, node.arguments[1]) ?? "dynamic"),
      explicitSchemas: [...explicit].sort().map((name) => schemaReference(name, schemas)),
      signatureSha256: sha256(JSON.stringify({ bodyType: type })),
    });
  });
  if (successfulResponses.length === 0) {
    visit(handler, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol === undefined) return;
      for (const declaration of resolvedSymbol(checker, symbol).declarations ?? []) {
        if (!declaration.getSourceFile().fileName.includes("/apps/api/src/product-routes/"))
          continue;
        const rendered = normalizedDeclaration(declaration);
        if (!/\.json\(/u.test(rendered)) continue;
        const status = /\.json\([^,]+,\s*(\d+)\)/u.exec(rendered)?.[1] ?? "dynamic";
        const bodyArgument = node.arguments.at(-1);
        if (bodyArgument === undefined) {
          throw new Error(`公开响应helper缺少可观察响应体：${node.expression.text}`);
        }
        successfulResponses.push({
          source: "json",
          status,
          explicitSchemas: [],
          signatureSha256: sha256(
            JSON.stringify({
              bodyType: observableTypeString(checker, bodyArgument, "公开响应helper响应体"),
            }),
          ),
        });
      }
    });
  }
  const queryParsers = queryParserContracts(handler, checker, initializers, schemas);
  for (const parser of queryParsers) {
    for (const schema of parser.schemas) querySchemas.add(schema.identity);
  }
  return {
    pathParameters: pathParameters.sort((left, right) => left.name.localeCompare(right.name)),
    query: {
      parsers: queryParsers,
      schemas: [...querySchemas].sort().map((name) => schemaReference(name, schemas)),
    },
    body: {
      schemas: [...bodySchemas].sort().map((name) => schemaReference(name, schemas)),
    },
    responseSchemaNames,
    successfulResponses,
  };
}

function observableTypeString(checker, node, label) {
  const type = checker.typeToString(
    checker.getTypeAtLocation(node),
    node,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  if (type === "any" || type === "unknown") {
    throw new Error(`${label}缺少可冻结的公开类型；请声明响应Schema或具体类型`);
  }
  return type;
}

export function classifySchemaRolesForTest(source) {
  const file = ts.createSourceFile("route-fixture.ts", source, ts.ScriptTarget.Latest, true);
  const initializers = variableInitializers(file);
  const request = new Set();
  const response = new Set();
  visit(file, (node) => {
    const parsed = schemaParse(node);
    if (parsed === undefined || parsed.input === undefined) return;
    if (requestSourceKinds(parsed.input, initializers).size > 0) request.add(parsed.name);
  });
  visit(file, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "json" ||
      node.arguments[0] === undefined
    ) {
      return;
    }
    visit(node.arguments[0], (nested) => {
      const parsed = schemaParse(nested);
      if (
        parsed !== undefined &&
        parsed.input !== undefined &&
        requestSourceKinds(parsed.input, initializers).size === 0
      ) {
        response.add(parsed.name);
      }
    });
  });
  return { request: [...request].sort(), response: [...response].sort() };
}

export function observableRouteContractFromFixtureForTest(source) {
  const fixturePath = join(ROOT, ".api-surface-observable-route-fixture.ts");
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => path === fixturePath || originalFileExists(path);
  host.readFile = (path) => (path === fixturePath ? source : originalReadFile(path));
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fixturePath
      ? ts.createSourceFile(path, source, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [fixturePath], options, host });
  const file = program.getSourceFile(fixturePath);
  if (file === undefined) throw new Error("测试fixture未进入TypeScript Program");
  let handler;
  visit(file, (node) => {
    if (
      handler === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "handler" &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      handler = node.initializer;
    }
  });
  if (handler === undefined) throw new Error("测试fixture缺少handler函数");
  const contract = routeContract(handler, program.getTypeChecker(), new Map());
  return {
    successfulResponses: contract.successfulResponses,
    responseSchemas: observableResponseSchemas("GET", "/api/fixture", contract, new Map()),
  };
}

export function assertPublicContractNameAllowed(name) {
  if (FORBIDDEN_PUBLIC_NAME.test(name)) {
    throw new Error(`@chat/contracts/public导出禁止的Runtime身份：${name}`);
  }
}

function parseProgram() {
  // API tsconfig是公开HTTP组合根；Contracts和workspace公开入口补齐外部Schema与export事实。
  // 内部Application调用图不属于公共API兼容身份，因此这里不额外加载其组合根。
  const configPath = join(ROOT, "apps/api/tsconfig.json");
  if (!existsSync(configPath)) throw new Error("缺少API tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return ts.createProgram({
    rootNames: [
      ...new Set([
        ...parsed.fileNames,
        join(CONTRACTS_ROOT, "public.ts"),
        ...workspacePublicEntryTargets(),
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

function observableResponseSchemas(method, path, contract, schemas) {
  if (contract.successfulResponses.length === 0) {
    throw new Error(`公开路由缺少可观察的成功响应合同：${method} ${path}`);
  }
  if (contract.responseSchemaNames.size > 0) {
    return [...contract.responseSchemaNames].sort().map((name) => schemaReference(name, schemas));
  }
  return contract.successfulResponses.map((response, index) => ({
    identity: `response-expression:${method} ${path}:${String(index + 1)}`,
    schemaVersions: [],
    signatureSha256: response.signatureSha256,
  }));
}

function collectRoutes(program, schemas) {
  const checker = program.getTypeChecker();
  const routes = [];
  const app = program.getSourceFile(join(ROOT, "apps/api/src/app.ts"));
  if (app === undefined) throw new Error("TypeScript Program缺少apps/api/src/app.ts");
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
    if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
    const contract = routeContract(handler, checker, schemas);
    routes.push({
      method,
      path: path.text,
      kind: method === "GET" ? "query" : "command",
      pathParameters: contract.pathParameters,
      query: contract.query,
      body: contract.body,
      requestSchemas: [],
      responseSchemas: observableResponseSchemas(method, path.text, contract, schemas),
      successfulResponses: contract.successfulResponses,
    });
  });
  if (!productMounted) throw new Error("apps/api组合根未把createProductRouter挂载到/api");

  for (const path of productRouteFiles()) {
    const file = program.getSourceFile(path);
    if (file === undefined) throw new Error(`TypeScript Program缺少公开路由文件：${path}`);
    visit(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
      const routePath = node.arguments[0];
      const handler = node.arguments.at(-1);
      if (!ts.isStringLiteral(routePath) || handler === undefined) return;
      if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
      const contract = routeContract(handler, checker, schemas);
      const requestNames = new Set([
        ...contract.pathParameters.map((entry) => entry.schema.identity),
        ...contract.query.schemas.map((entry) => entry.identity),
        ...contract.body.schemas.map((entry) => entry.identity),
      ]);
      const publicPath = `/api${routePath.text}`;
      routes.push({
        method,
        path: publicPath,
        kind: method === "GET" ? "query" : "command",
        pathParameters: contract.pathParameters,
        query: contract.query,
        body: contract.body,
        requestSchemas: [...requestNames].sort().map((name) => schemaReference(name, schemas)),
        responseSchemas: observableResponseSchemas(method, publicPath, contract, schemas),
        successfulResponses: contract.successfulResponses,
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

function declarationClosure(
  checker,
  declaration,
  collected = new Set(),
  visiting = new Set(),
  allowedRoot = CONTRACTS_ROOT,
  completed = new Set(),
) {
  const key = `${declaration.getSourceFile().fileName}:${String(declaration.pos)}:${String(declaration.end)}`;
  if (visiting.has(key) || completed.has(key)) return collected;
  visiting.add(key);
  collected.add(normalizedDeclaration(declaration));
  visit(declaration, (node) => {
    if (!ts.isIdentifier(node)) return;
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return;
    const actual = resolvedSymbol(checker, symbol);
    for (const nested of actual.declarations ?? []) {
      const nestedPath = nested.getSourceFile().fileName;
      if (
        !nestedPath.startsWith(allowedRoot) ||
        nestedPath.includes(`${sep}node_modules${sep}`) ||
        nestedPath.includes(`${sep}src${sep}internal-compat${sep}`)
      )
        continue;
      if (
        ts.isVariableDeclaration(nested) ||
        ts.isTypeAliasDeclaration(nested) ||
        ts.isInterfaceDeclaration(nested) ||
        ts.isEnumDeclaration(nested)
      ) {
        declarationClosure(checker, nested, collected, visiting, allowedRoot, completed);
      }
    }
  });
  visiting.delete(key);
  completed.add(key);
  return collected;
}

function declarationName(declaration) {
  if ("name" in declaration && declaration.name !== undefined) {
    return declaration.name.getText(declaration.getSourceFile());
  }
  return "";
}

export function assertPublicContractIdentityAllowedForTest(evidence) {
  for (const value of evidence) {
    if (FORBIDDEN_PUBLIC_NAME.test(value) || FORBIDDEN_PUBLIC_IDENTITY.test(value)) {
      throw new Error(`公开导出禁止的Runtime/凭据身份：${value}`);
    }
  }
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

function allContractSchemas(program) {
  const checker = program.getTypeChecker();
  const schemas = new Map();
  const ambiguous = new Set();
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(CONTRACTS_ROOT)) continue;
    visit(file, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.name.text.endsWith("Schema") ||
        node.initializer === undefined
      ) {
        return;
      }
      const name = node.name.text;
      if (ambiguous.has(name)) return;
      if (schemas.has(name)) {
        schemas.delete(name);
        ambiguous.add(name);
        return;
      }
      const closure = declarationClosure(checker, node);
      const facts = schemaFacts(checker, [node]);
      schemas.set(name, {
        name,
        signatureSha256: sha256([...closure].sort().join("\n")),
        ...facts,
      });
    });
  }
  return schemas;
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
    assertPublicContractNameAllowed(name);
    const actual = resolvedSymbol(checker, exported);
    const declarations = (actual.declarations ?? []).filter((declaration) =>
      declaration.getSourceFile().fileName.startsWith(CONTRACTS_ROOT),
    );
    if (declarations.length === 0) continue;
    const closure = new Set();
    for (const declaration of declarations) declarationClosure(checker, declaration, closure);
    assertPublicContractIdentityAllowedForTest([
      name,
      actual.getName(),
      ...declarations.flatMap((declaration) => [
        declarationName(declaration),
        relative(ROOT, declaration.getSourceFile().fileName).split(sep).join("/"),
      ]),
      ...closure,
    ]);
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

function exportedTarget(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  for (const condition of ["types", "import", "default", "node"]) {
    const target = exportedTarget(value[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

function workspaceManifests() {
  const packages = [];
  for (const parent of [join(ROOT, "apps"), join(ROOT, "packages")]) {
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name, "package.json");
      if (!existsSync(path)) continue;
      packages.push({ root: dirname(path), manifest: JSON.parse(readFileSync(path, "utf8")) });
    }
  }
  return packages;
}

function workspacePublicEntryTargets() {
  const targets = [];
  for (const entry of workspaceManifests()) {
    const exports =
      typeof entry.manifest.exports === "string"
        ? { ".": entry.manifest.exports }
        : (entry.manifest.exports ?? {});
    for (const value of Object.values(exports)) {
      const target = exportedTarget(value);
      if (typeof target !== "string") continue;
      const absolute = resolve(entry.root, target);
      if (existsSync(absolute) && /\.[cm]?[jt]sx?$/u.test(absolute)) targets.push(absolute);
    }
  }
  return [...new Set(targets)].sort();
}

function moduleEntryContract(program, path, fallback, packageRoot) {
  const file = program.getSourceFile(path);
  if (file === undefined) {
    const content = existsSync(path) ? readFileSync(path, "utf8") : fallback;
    const parsed = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const names = new Set();
    visit(parsed, (node) => {
      if (ts.isExportAssignment(node)) names.add("default");
      if (ts.isExportSpecifier(node)) names.add(node.name.text);
      if (
        "modifiers" in node &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        "name" in node &&
        node.name !== undefined
      ) {
        names.add(node.name.getText(parsed));
      }
    });
    return {
      exportedSymbols: [...names].sort(),
      transitiveSignatureSha256: sha256(content),
    };
  }
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) {
    return {
      exportedSymbols: [],
      transitiveSignatureSha256: sha256(normalizedDeclaration(file)),
    };
  }
  const moduleClosure = new Set();
  const completedDeclarations = new Set();
  const signatureFacts = [];
  const exportedSymbols = checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => {
      const actual = resolvedSymbol(checker, exported);
      const declarations = (actual.declarations ?? []).filter((declaration) =>
        declaration.getSourceFile().fileName.startsWith(ROOT),
      );
      const declaration = declarations[0];
      if (declaration === undefined) {
        const forbidden =
          FORBIDDEN_PUBLIC_NAME.test(exported.getName()) ||
          FORBIDDEN_PUBLIC_IDENTITY.test(actual.getName());
        signatureFacts.push({
          exported: exported.getName(),
          resolved: actual.getName(),
          signature: "unresolved",
        });
        return forbidden
          ? `redacted:${sha256(`${exported.getName()}:${actual.getName()}`)}`
          : exported.getName();
      }
      const type = checker.typeToString(
        checker.getTypeOfSymbolAtLocation(actual, declaration),
        declaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
      for (const nested of declarations) {
        declarationClosure(
          checker,
          nested,
          moduleClosure,
          new Set(),
          packageRoot,
          completedDeclarations,
        );
      }
      const forbidden =
        FORBIDDEN_PUBLIC_NAME.test(exported.getName()) ||
        FORBIDDEN_PUBLIC_IDENTITY.test(actual.getName());
      signatureFacts.push({
        exported: exported.getName(),
        resolved: actual.getName(),
        type,
        declarations: declarations.map(normalizedDeclaration).sort(),
      });
      return forbidden
        ? `redacted:${sha256(`${exported.getName()}:${actual.getName()}`)}`
        : exported.getName();
    })
    .sort((left, right) => left.localeCompare(right));
  return {
    exportedSymbols,
    transitiveSignatureSha256: sha256(
      JSON.stringify({
        exportedSymbols,
        signatureFacts: signatureFacts.sort((left, right) =>
          left.exported.localeCompare(right.exported),
        ),
        closure: [...moduleClosure].sort(),
      }),
    ),
  };
}

function packageExports(program) {
  const packages = [];
  const contractCache = new Map();
  for (const { root, manifest } of workspaceManifests()) {
    const exports =
      typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
    const internalExports = manifest.chatApiSurface?.internalExports ?? [];
    if (
      !Array.isArray(internalExports) ||
      new Set(internalExports).size !== internalExports.length
    ) {
      throw new Error(`${manifest.name}.chatApiSurface.internalExports必须是无重复数组`);
    }
    for (const key of internalExports) {
      if (exports[key] === undefined)
        throw new Error(`${manifest.name}内部export分类引用不存在：${key}`);
    }
    const subpaths = Object.entries(exports)
      .map(([key, conditions]) => {
        const target = exportedTarget(conditions);
        if (typeof target !== "string") throw new Error(`${manifest.name}:${key} export缺少target`);
        const absoluteTarget = resolve(root, target);
        const cacheKey = `${absoluteTarget}:${JSON.stringify(conditions)}`;
        let contract = contractCache.get(cacheKey);
        if (contract === undefined) {
          contract = moduleEntryContract(program, absoluteTarget, JSON.stringify(conditions), root);
          contractCache.set(cacheKey, contract);
        }
        return {
          key,
          visibility: internalExports.includes(key) ? "internal" : "public",
          target,
          conditions: stable(conditions),
          ...contract,
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    const rootContract = subpaths.find((entry) => entry.key === ".");
    packages.push({
      name: manifest.name,
      exportPaths: subpaths.map((entry) => entry.key),
      exports: stable(exports),
      subpaths,
      executableCommands: Object.keys(manifest.bin ?? {}).sort(),
      bin: stable(manifest.bin ?? {}),
      publicEntrySignatureSha256:
        rootContract?.transitiveSignatureSha256 ?? sha256(JSON.stringify(exports)),
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function generateApiSurface() {
  const program = parseProgram();
  const contracts = publicContracts(program);
  const routeSchemas = allContractSchemas(program);
  const problem = contracts.schemas.get("problemCodeSchema");
  const recovery = contracts.schemas.get("recoveryActionSchema");
  const routes = collectRoutes(program, routeSchemas).map((route) => ({
    ...route,
    problemContract: {
      problemCodeSchema: schemaReference("problemCodeSchema", contracts.schemas),
      recoveryActionSchema: schemaReference("recoveryActionSchema", contracts.schemas),
      codes: problem?.enumValues ?? [],
      recoveryActions: recovery?.enumValues ?? [],
    },
  }));
  const manifest = {
    schemaVersion: "chat-public-api-surface.v2",
    generation: {
      apiCompositionRoot: "apps/api:createApiApp",
      browserContractEntry: "@chat/contracts/public",
      packageExportSource: "workspace-package-manifests",
      packageExportExtraction: "all-subpaths-and-transitive-symbols.v2",
      routeContractExtraction: "observable-response-type-contract.v5",
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
    packageExports: packageExports(program),
    publicSymbols: contracts.symbols,
    deprecated: contracts.deprecated,
  };
  const rendered = json(manifest);
  const forbiddenManifestIdentity = FORBIDDEN_MANIFEST_TEXT.exec(rendered)?.[0];
  if (forbiddenManifestIdentity !== undefined) {
    throw new Error(
      `API Surface包含私有Runtime身份、凭据或Prompt字段：${forbiddenManifestIdentity}`,
    );
  }
  return stable(manifest);
}

const ADDITIVE_ISSUES = new Set([
  "route_added",
  "package_export_added",
  "public_symbol_added",
  "schema_added",
  "command_type_added",
  "query_type_added",
  "problem_code_added",
  "recovery_action_added",
]);

function digest(value) {
  return sha256(json(value));
}

function issue(kind, target, before, after, detail = {}) {
  const baseDigest = digest(before ?? { state: "absent" });
  const currentDigest = digest(after ?? { state: "absent" });
  return {
    issueId: `${kind}:${target}`,
    kind,
    target,
    baseDigest,
    currentDigest,
    diffSha256: sha256(json({ kind, target, baseDigest, currentDigest })),
    ...detail,
  };
}

function mapBy(items, key) {
  return new Map(items.map((item) => [key(item), item]));
}

function stripRetiredInternalRouteFields(value) {
  for (const route of value.routes ?? []) {
    delete route.applicationOperations;
    delete route.applicationOperationContracts;
    route.successfulResponses = (route.successfulResponses ?? []).map((response) => {
      const normalized = { ...response };
      delete normalized.applicationResultSignatureSha256;
      return normalized;
    });
  }
  return value;
}

const API_SURFACE_NORMALIZERS = Object.freeze({
  "chat-public-api-surface.v2": stripRetiredInternalRouteFields,
  "chat-public-api-surface.v3": stripRetiredInternalRouteFields,
});

function normalizeApiSurface(value) {
  const normalizer = API_SURFACE_NORMALIZERS[value?.schemaVersion];
  if (normalizer === undefined) {
    throw new Error(
      `API Surface Manifest缺少显式migration/normalizer：${String(value?.schemaVersion)}`,
    );
  }
  const normalized = normalizer(structuredClone(value));
  for (const field of ["routes", "packageExports", "publicSymbols", "publicSchemas"]) {
    if (!Array.isArray(normalized[field])) throw new Error(`API Surface缺少可比较字段：${field}`);
  }
  if (
    !Array.isArray(normalized.commandTypes) ||
    !Array.isArray(normalized.queryTypes) ||
    !Array.isArray(normalized.problems?.codes) ||
    !Array.isArray(normalized.problems?.recoveryActions)
  ) {
    throw new Error("API Surface缺少Command/Query/Problem可比较字段");
  }
  return normalized;
}

function routeForComparison(route, fromExtraction, toExtraction) {
  const normalized = stripRetiredInternalRouteFields({ routes: [structuredClone(route)] })
    .routes[0];
  const extractionPair = new Set([fromExtraction, toExtraction]);
  const currentExtraction = "observable-response-type-contract.v5";
  const historicalExtractions = new Set([
    "request-source-and-success-response-dataflow.v2",
    "request-helper-operation-and-success-response-dataflow.v3",
    "observable-request-response-dataflow.v4",
  ]);
  const crossesExternalContractBoundary =
    (extractionPair.has(currentExtraction) &&
      [...historicalExtractions].some((extraction) => extractionPair.has(extraction))) ||
    (extractionPair.has("observable-request-response-dataflow.v4") &&
      (extractionPair.has("request-source-and-success-response-dataflow.v2") ||
        extractionPair.has("request-helper-operation-and-success-response-dataflow.v3")));
  if (crossesExternalContractBoundary) {
    // v4退出内部Application调用图，v5进一步只冻结公开响应类型。迁移比较只保留
    // 各代生成器共同拥有的外部事实；同代比较仍严格检查响应类型、Schema与HTTP状态。
    delete normalized.applicationOperations;
    delete normalized.applicationOperationContracts;
    normalized.successfulResponses = (normalized.successfulResponses ?? []).map((response) => ({
      source: "json",
      status: response.status,
      explicitSchemas: response.explicitSchemas,
      signatureSha256: sha256("observable-response-extractor-transition.v5"),
    }));
    const explicitSchemas = normalized.successfulResponses.flatMap(
      (response) => response.explicitSchemas ?? [],
    );
    normalized.responseSchemas =
      explicitSchemas.length > 0
        ? [...new Map(explicitSchemas.map((schema) => [schema.identity, schema])).values()].sort(
            (left, right) => left.identity.localeCompare(right.identity),
          )
        : normalized.successfulResponses.map((response, index) => ({
            identity: `response-expression:migrated:${String(index + 1)}`,
            schemaVersions: [],
            signatureSha256: sha256(
              JSON.stringify({
                migration: "observable-response-extractor-transition.v5",
                source: response.source,
                status: response.status,
              }),
            ),
          }));
  }
  return normalized;
}

function normalizedSubpaths(entry) {
  if (Array.isArray(entry.subpaths)) return entry.subpaths;
  return entry.exportPaths.map((key) => ({
    key,
    visibility: "legacy-unclassified",
    target: exportedTarget(entry.exports?.[key]),
    conditions: entry.exports?.[key],
    exportedSymbols: undefined,
    transitiveSignatureSha256: key === "." ? entry.publicEntrySignatureSha256 : undefined,
  }));
}

export function diffApiSurface(baseline, current) {
  const baselineSchemaVersion = baseline?.schemaVersion;
  const currentSchemaVersion = current?.schemaVersion;
  const baselineHadSubpaths = baseline?.packageExports?.some((entry) =>
    Array.isArray(entry.subpaths),
  );
  baseline = normalizeApiSurface(baseline);
  current = normalizeApiSurface(current);
  const issues = [];
  if (baselineSchemaVersion !== currentSchemaVersion) {
    issues.push(
      issue(
        "manifest_schema_version_changed",
        "api-surface-manifest",
        baselineSchemaVersion,
        currentSchemaVersion,
      ),
    );
  }
  const previousRoutes = mapBy(baseline.routes, (route) => `${route.method} ${route.path}`);
  const currentRoutes = mapBy(current.routes, (route) => `${route.method} ${route.path}`);
  for (const [key, route] of previousRoutes) {
    const next = currentRoutes.get(key);
    if (next === undefined) issues.push(issue("route_removed", key, route, undefined));
    else {
      const previousComparable = routeForComparison(
        route,
        baseline.generation?.routeContractExtraction,
        current.generation?.routeContractExtraction,
      );
      const currentComparable = routeForComparison(
        next,
        current.generation?.routeContractExtraction,
        baseline.generation?.routeContractExtraction,
      );
      if (digest(previousComparable) !== digest(currentComparable)) {
        issues.push(issue("route_contract_changed", key, route, next));
      }
    }
  }
  for (const [key, route] of currentRoutes) {
    if (!previousRoutes.has(key)) issues.push(issue("route_added", key, undefined, route));
  }

  const previousPackages = mapBy(baseline.packageExports, (entry) => entry.name);
  const currentPackages = mapBy(current.packageExports, (entry) => entry.name);
  for (const [name, entry] of previousPackages) {
    const next = currentPackages.get(name);
    for (const exportPath of entry.exportPaths) {
      if (next === undefined || !next.exportPaths.includes(exportPath)) {
        issues.push(
          issue(
            "package_export_removed",
            `${name}:${exportPath}`,
            entry.exports?.[exportPath] ?? exportPath,
          ),
        );
      } else if (digest(entry.exports?.[exportPath]) !== digest(next.exports?.[exportPath])) {
        issues.push(
          issue(
            "package_export_changed",
            `${name}:${exportPath}`,
            entry.exports?.[exportPath],
            next.exports?.[exportPath],
          ),
        );
      }
    }
    if (
      next !== undefined &&
      (digest(entry.bin) !== digest(next.bin) ||
        (baselineHadSubpaths &&
          entry.publicEntrySignatureSha256 !== next.publicEntrySignatureSha256))
    ) {
      issues.push(issue("package_executable_or_entry_changed", name, entry, next));
    }
  }
  for (const [name, entry] of currentPackages) {
    const previous = previousPackages.get(name);
    for (const exportPath of entry.exportPaths) {
      if (previous === undefined || !previous.exportPaths.includes(exportPath)) {
        const currentSubpath = normalizedSubpaths(entry).find(
          (subpath) => subpath.key === exportPath,
        );
        if (!baselineHadSubpaths && currentSubpath?.visibility === "internal") continue;
        issues.push(
          issue(
            "package_export_added",
            `${name}:${exportPath}`,
            undefined,
            entry.exports?.[exportPath] ?? exportPath,
          ),
        );
      }
    }
  }

  for (const [name, entry] of previousPackages) {
    const next = currentPackages.get(name);
    if (next === undefined) continue;
    const beforeSubpaths = mapBy(normalizedSubpaths(entry), (subpath) => subpath.key);
    const afterSubpaths = mapBy(normalizedSubpaths(next), (subpath) => subpath.key);
    for (const [key, before] of beforeSubpaths) {
      const after = afterSubpaths.get(key);
      if (after === undefined) continue;
      const comparableBefore = {
        visibility: before.visibility,
        target: before.target,
        conditions: before.conditions,
        exportedSymbols: before.exportedSymbols,
        transitiveSignatureSha256: before.transitiveSignatureSha256,
      };
      const comparableAfter = {
        visibility:
          before.visibility === "legacy-unclassified" ? "legacy-unclassified" : after.visibility,
        target: after.target,
        conditions: after.conditions,
        exportedSymbols: before.exportedSymbols === undefined ? undefined : after.exportedSymbols,
        transitiveSignatureSha256:
          before.transitiveSignatureSha256 === undefined || !baselineHadSubpaths
            ? before.transitiveSignatureSha256
            : after.transitiveSignatureSha256,
      };
      if (digest(comparableBefore) !== digest(comparableAfter)) {
        const target = `${name}:${key}`;
        if (!issues.some((entry) => entry.issueId === `package_export_changed:${target}`)) {
          issues.push(issue("package_export_changed", target, before, after));
        }
      }
    }
  }

  const previousSymbols = mapBy(baseline.publicSymbols, (entry) => entry.name);
  const currentSymbols = mapBy(current.publicSymbols, (entry) => entry.name);
  for (const [name, symbol] of previousSymbols) {
    const next = currentSymbols.get(name);
    if (next === undefined) issues.push(issue("public_symbol_removed", name, symbol));
    else if (symbol.kind !== "schema" && symbol.signatureSha256 !== next.signatureSha256) {
      issues.push(issue("public_symbol_changed", name, symbol, next));
    }
  }
  for (const [name, symbol] of currentSymbols) {
    if (!previousSymbols.has(name))
      issues.push(issue("public_symbol_added", name, undefined, symbol));
  }

  const previousSchemas = mapBy(baseline.publicSchemas, (entry) => entry.name);
  const currentSchemas = mapBy(current.publicSchemas, (entry) => entry.name);
  for (const [name, schema] of previousSchemas) {
    const next = currentSchemas.get(name);
    if (next === undefined) {
      issues.push(issue("schema_removed", name, schema));
      continue;
    }
    for (const field of next.requiredFields.filter(
      (field) => !schema.requiredFields.includes(field),
    )) {
      issues.push(issue("required_field_added", `${name}.${field}`, schema, next));
    }
    for (const value of schema.enumValues.filter((value) => !next.enumValues.includes(value))) {
      issues.push(issue("enum_narrowed", `${name}:${value}`, schema, next));
    }
    if (schema.signatureSha256 !== next.signatureSha256) {
      const sameGeneration =
        JSON.stringify(schema.schemaVersions) === JSON.stringify(next.schemaVersions);
      issues.push(
        issue(
          sameGeneration ? "same_schema_literal_changed" : "schema_generation_changed",
          name,
          schema,
          next,
        ),
      );
    }
  }
  for (const [name, schema] of currentSchemas) {
    if (!previousSchemas.has(name)) issues.push(issue("schema_added", name, undefined, schema));
  }

  for (const [kind, beforeValues, afterValues] of [
    ["command_type", baseline.commandTypes, current.commandTypes],
    ["query_type", baseline.queryTypes, current.queryTypes],
    ["problem_code", baseline.problems.codes, current.problems.codes],
    ["recovery_action", baseline.problems.recoveryActions, current.problems.recoveryActions],
  ]) {
    const before = new Set(beforeValues);
    const after = new Set(afterValues);
    for (const value of before) {
      if (!after.has(value)) issues.push(issue(`${kind}_removed`, value, value));
    }
    for (const value of after) {
      if (!before.has(value)) issues.push(issue(`${kind}_added`, value, undefined, value));
    }
  }
  return issues.sort((left, right) => left.issueId.localeCompare(right.issueId));
}

function validateExactRecords(value, collection, label, fields) {
  if (value === null || typeof value !== "object" || value.schemaVersion !== 2) {
    throw new Error(`${label}必须是schemaVersion=2的对象`);
  }
  if (!Array.isArray(value[collection])) throw new Error(`${label}列表缺失`);
  const seen = new Set();
  for (const record of value[collection]) {
    for (const field of [
      "issueKind",
      "target",
      "baseDigest",
      "currentDigest",
      "diffSha256",
      ...fields,
    ]) {
      if (typeof record?.[field] !== "string" || record[field].trim() === "") {
        throw new Error(`${label}缺少${field}`);
      }
    }
    for (const field of ["baseDigest", "currentDigest", "diffSha256"]) {
      if (!/^[0-9a-f]{64}$/u.test(record[field])) throw new Error(`${label}.${field}不是SHA-256`);
    }
    const key = `${record.issueKind}:${record.target}:${record.diffSha256}`;
    if (seen.has(key)) throw new Error(`重复${label}：${key}`);
    seen.add(key);
  }
  return value[collection];
}

export function validateWaivers(value) {
  const waivers = validateExactRecords(value, "waivers", "breaking change waiver", [
    "approvedBy",
    "approvalReference",
    "detect",
    "why",
    "fix",
    "verify",
    "rollback",
  ]);
  for (const waiver of waivers) {
    if (!waiver.approvedBy.startsWith("user:")) {
      throw new Error("breaking change waiver必须记录明确用户批准（approvedBy=user:...）");
    }
  }
  return waivers;
}

export function validateCompatibleChangeRecords(value) {
  return validateExactRecords(value, "changes", "compatible surface change record", [
    "purpose",
    "owner",
    "verification",
    "rollbackOrRemoval",
  ]);
}

function recordMatchesIssue(record, entry) {
  return (
    record.issueKind === entry.kind &&
    record.target === entry.target &&
    record.baseDigest === entry.baseDigest &&
    record.currentDigest === entry.currentDigest &&
    record.diffSha256 === entry.diffSha256
  );
}

export function assertApiSurfaceCompatible(
  baseline,
  current,
  waiverDocument,
  compatibleChangeDocument = { schemaVersion: 2, changes: [] },
) {
  const issues = diffApiSurface(baseline, current);
  const waivers = validateWaivers(waiverDocument);
  const changes = validateCompatibleChangeRecords(compatibleChangeDocument);
  const additive = issues.filter((entry) => ADDITIVE_ISSUES.has(entry.kind));
  const breaking = issues.filter((entry) => !ADDITIVE_ISSUES.has(entry.kind));
  const staleWaivers = waivers.filter(
    (waiver) => !breaking.some((entry) => recordMatchesIssue(waiver, entry)),
  );
  if (staleWaivers.length > 0) throw new Error("存在摘要或diff已过期的breaking change waiver");
  const staleChanges = changes.filter(
    (record) => !additive.some((entry) => recordMatchesIssue(record, entry)),
  );
  if (staleChanges.length > 0) throw new Error("存在摘要或diff已过期的compatible change record");
  const missingChanges = additive.filter(
    (entry) => !changes.some((record) => recordMatchesIssue(record, entry)),
  );
  if (missingChanges.length > 0) {
    throw new Error(
      `API Surface新增缺少精确compatible change record：\n${missingChanges
        .map((entry) => `- ${entry.issueId}`)
        .join("\n")}`,
    );
  }
  const missingWaivers = breaking.filter(
    (entry) => !waivers.some((waiver) => recordMatchesIssue(waiver, entry)),
  );
  if (missingWaivers.length > 0) {
    throw new Error(
      `API Surface存在未获用户明确批准的breaking change：\n${missingWaivers
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
  compatibleChangeDocument = { schemaVersion: 2, changes: [] },
) {
  if (json(checkedInBaseline) !== json(current)) {
    throw new Error("API Surface生成结果与checked-in baseline漂移；必须先审查并更新baseline");
  }
  if (baseBaseline === undefined) {
    const waivers = validateWaivers(waiverDocument);
    const changes = validateCompatibleChangeRecords(compatibleChangeDocument);
    if (waivers.length > 0 || changes.length > 0) {
      throw new Error("没有base baseline时不得保留API change record或breaking change waiver");
    }
    return [];
  }
  return assertApiSurfaceCompatible(
    baseBaseline,
    current,
    waiverDocument,
    compatibleChangeDocument,
  );
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
    load(CHANGE_RECORD_PATH),
  );
  if (compatibilityBase.sha !== undefined) {
    process.stdout.write(`API Surface compatibility base：${compatibilityBase.sha}\n`);
  }
  process.stdout.write(readableDiff(issues));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
