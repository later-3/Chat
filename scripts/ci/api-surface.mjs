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
const APPLICATION_ROOT = join(ROOT, "packages/application/src");
const API_SOURCE_ROOT = join(ROOT, "apps/api/src");
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

function expressionClosure(expression, initializers, output = new Set(), seen = new Set()) {
  output.add(normalizedDeclaration(expression));
  visit(expression, (node) => {
    if (!ts.isIdentifier(node) || !initializers.has(node.text) || seen.has(node.text)) return;
    seen.add(node.text);
    expressionClosure(initializers.get(node.text), initializers, output, seen);
  });
  return output;
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
    const type = checker.typeToString(
      checker.getTypeAtLocation(expression),
      expression,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    successfulResponses.push({
      source: "c.json",
      status:
        node.arguments[1] === undefined
          ? "default"
          : (resolvedLiteralText(checker, node.arguments[1]) ?? "dynamic"),
      explicitSchemas: [...explicit].sort().map((name) => schemaReference(name, schemas)),
      signatureSha256: sha256(
        JSON.stringify({ type, closure: [...expressionClosure(expression, initializers)].sort() }),
      ),
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
        successfulResponses.push({
          source: `response-helper:${node.expression.text}`,
          status,
          explicitSchemas: [],
          signatureSha256: sha256(
            JSON.stringify({
              helper: rendered,
              call: [...expressionClosure(node, initializers)].sort(),
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

export function assertPublicContractNameAllowed(name) {
  if (FORBIDDEN_PUBLIC_NAME.test(name)) {
    throw new Error(`@chat/contracts/public导出禁止的Runtime身份：${name}`);
  }
}

function callableDeclaration(declaration) {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  if (
    ts.isPropertyAssignment(declaration) &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return undefined;
}

function declarationKey(declaration) {
  return `${declaration.getSourceFile().fileName}:${String(declaration.pos)}:${String(declaration.end)}`;
}

function actualSymbol(checker, node) {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol === undefined ? undefined : resolvedSymbol(checker, symbol);
}

function symbolKey(symbol) {
  return (symbol.declarations ?? []).map(declarationKey).sort().join("|") || symbol.getName();
}

function unknownCallable(reason) {
  return { kind: "unknown", reason };
}

function ordinaryValue(reason) {
  return { kind: "ordinary", reason };
}

function callableValue(declarations) {
  return {
    kind: "callable",
    declarations: [
      ...new Map(declarations.map((entry) => [declarationKey(entry), entry])).values(),
    ],
  };
}

function valueKey(value) {
  if (value.kind === "unknown") return `unknown:${value.reason}`;
  if (value.kind === "ordinary") return `ordinary:${value.reason}`;
  if (value.kind === "callable") {
    return `callable:${value.declarations.map(declarationKey).sort().join(",")}`;
  }
  return `object:${[...value.properties.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => `${name}=${valueKey(entry)}`)
    .join(",")}`;
}

function hasExternallyOwnedType(checker, node) {
  const pending = [checker.getTypeAtLocation(node)];
  const declarations = [];
  const seen = new Set();
  while (pending.length > 0) {
    const type = pending.pop();
    if (seen.has(type)) continue;
    seen.add(type);
    if (type.isUnionOrIntersection()) {
      pending.push(...type.types);
      continue;
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol !== undefined) declarations.push(...(symbol.declarations ?? []));
  }
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const source = declaration.getSourceFile().fileName;
      return !source.startsWith(APPLICATION_ROOT) && !source.startsWith(API_SOURCE_ROOT);
    })
  );
}

function propertyName(node) {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function normalizedCalleeExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Callback值只允许编译期可确定的函数或对象成员。参数、解构成员和局部别名都通过
 * 同一bindings环境解析；动态分支不猜测，会在真正调用该值时失败关闭。
 */
function staticCallableValue(node, checker, bindings, resolving = new Set()) {
  const normalizedNode = normalizedCalleeExpression(node);
  if (normalizedNode !== node) {
    return staticCallableValue(normalizedNode, checker, bindings, resolving);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return callableValue([node]);
  if (ts.isObjectLiteralExpression(node)) {
    const properties = new Map();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        return unknownCallable("对象callback含动态spread");
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        properties.set(
          property.name.text,
          staticCallableValue(property.name, checker, bindings, resolving),
        );
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name === undefined) return unknownCallable("对象callback含动态属性名");
        properties.set(
          name,
          staticCallableValue(property.initializer, checker, bindings, resolving),
        );
        continue;
      }
      if (ts.isMethodDeclaration(property)) {
        const name = propertyName(property.name);
        if (name === undefined) return unknownCallable("对象callback含动态方法名");
        properties.set(name, callableValue([property]));
      }
    }
    return { kind: "object", properties };
  }
  if (ts.isConditionalExpression(node)) {
    const condition = resolvedLiteralText(checker, node.condition);
    if (condition === "true")
      return staticCallableValue(node.whenTrue, checker, bindings, resolving);
    if (condition === "false") {
      return staticCallableValue(node.whenFalse, checker, bindings, resolving);
    }
    return unknownCallable("动态条件选择callback");
  }
  if (ts.isPropertyAccessExpression(node)) {
    const owner = staticCallableValue(node.expression, checker, bindings, resolving);
    const propertySymbol = actualSymbol(checker, node.name);
    const propertyCallables = (propertySymbol?.declarations ?? []).filter(
      (declaration) => callableDeclaration(declaration) !== undefined,
    );
    if (owner.kind === "unknown") {
      // namespace import的owner本身不是callable，但静态属性symbol会精确解析到
      // named export声明；这里不以owner的unknown覆盖已解析的helper。
      return propertyCallables.length > 0 ? callableValue(propertyCallables) : owner;
    }
    if (owner.kind === "object") {
      return (
        owner.properties.get(node.name.text) ??
        unknownCallable(`对象缺少callback ${node.name.text}`)
      );
    }
    if (owner.kind === "ordinary") {
      return propertyCallables.length > 0
        ? callableValue(propertyCallables)
        : ordinaryValue(`外部owner静态属性 ${node.name.text}`);
    }
    if (propertySymbol === undefined)
      return unknownCallable(`无法解析属性callback ${node.name.text}`);
    return propertyCallables.length > 0
      ? callableValue(propertyCallables)
      : unknownCallable(`属性 ${node.name.text}不是静态callback`);
  }
  if (!ts.isIdentifier(node)) return unknownCallable(`动态callback ${normalizedDeclaration(node)}`);
  const symbol = actualSymbol(checker, node);
  if (symbol === undefined) return unknownCallable(`无法解析callback ${node.text}`);
  if (bindings.has(symbol)) return bindings.get(symbol);
  const key = symbolKey(symbol);
  if (resolving.has(key)) return unknownCallable(`callback别名循环 ${node.text}`);
  const nextResolving = new Set(resolving).add(key);
  const declarations = symbol.declarations ?? [];
  const callables = declarations.filter(
    (declaration) => callableDeclaration(declaration) !== undefined,
  );
  if (callables.length > 0) return callableValue(callables);
  for (const declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return staticCallableValue(declaration.initializer, checker, bindings, nextResolving);
    }
    if (ts.isPropertyAssignment(declaration)) {
      return staticCallableValue(declaration.initializer, checker, bindings, nextResolving);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return staticCallableValue(declaration.name, checker, bindings, nextResolving);
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const owner = pattern.parent;
      if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(owner)) {
        if (owner.initializer === undefined) {
          return unknownCallable(`局部解构callback ${node.text}缺少初始值`);
        }
        const object = staticCallableValue(owner.initializer, checker, bindings, nextResolving);
        const name = propertyName(declaration.propertyName ?? declaration.name);
        if (object.kind === "object" && name !== undefined) {
          return object.properties.get(name) ?? unknownCallable(`callback对象缺少 ${name}`);
        }
        return unknownCallable(`无法从动态对象解构callback ${name ?? "?"}`);
      }
      return unknownCallable(`解构callback ${node.text}未绑定`);
    }
    if (ts.isParameter(declaration)) {
      return hasExternallyOwnedType(checker, node)
        ? ordinaryValue(`外部类型参数 ${node.text}`)
        : unknownCallable(`参数callback ${node.text}未绑定`);
    }
  }
  if (hasExternallyOwnedType(checker, node)) {
    return ordinaryValue(`外部类型值 ${node.text}`);
  }
  return unknownCallable(`callback ${node.text}不是静态可调用值`);
}

function bindName(checker, name, value, bindings) {
  if (ts.isIdentifier(name)) {
    const symbol = actualSymbol(checker, name);
    if (symbol === undefined) throw new Error(`无法解析callback参数：${name.text}`);
    bindings.set(symbol, value);
    return;
  }
  if (!ts.isObjectBindingPattern(name)) {
    throw new Error("公开route callback参数包含不支持的动态绑定");
  }
  for (const element of name.elements) {
    if (element.dotDotDotToken !== undefined) {
      bindName(checker, element.name, unknownCallable("解构callback含rest"), bindings);
      continue;
    }
    const key = propertyName(element.propertyName ?? element.name);
    const nested =
      value.kind === "object" && key !== undefined
        ? (value.properties.get(key) ?? unknownCallable(`callback对象缺少 ${key}`))
        : unknownCallable(`无法从动态对象解构callback ${key ?? "?"}`);
    bindName(checker, element.name, nested, bindings);
  }
}

function frameKey(declaration, bindings) {
  return `${declarationKey(declaration)}|${[...bindings.entries()]
    .map(([symbol, value]) => `${symbolKey(symbol)}=${valueKey(value)}`)
    .sort()
    .join(";")}`;
}

function visitCallableCalls(callable, callback) {
  const root = callable.body ?? callable;
  const walk = (node) => {
    if (
      node !== root &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function isApplicationOperationDeclaration(checker, declaration) {
  const callable = callableDeclaration(declaration);
  if (callable === undefined) return false;
  if (
    !/(?:use-cases(?:\/|\.ts$)|operations\.ts$|service-status\.ts$)/u.test(
      declaration.getSourceFile().fileName,
    )
  ) {
    return false;
  }
  if (callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return true;
  const signature = checker.getSignatureFromDeclaration(callable);
  if (signature === undefined) return false;
  const returnType = checker.typeToString(checker.getReturnTypeOfSignature(signature), callable);
  return returnType !== "void" && returnType !== "never";
}

function isProvablyOrdinaryCall(call, checker, { allowApplicationTypePort = true } = {}) {
  const callee = normalizedCalleeExpression(call.expression);
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return false;
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  if (declaration === undefined) return false;
  const source = declaration.getSourceFile().fileName;
  // Application/API源码中的可调用值可能继续进入Operation闭包，不能当作普通调用放过。
  if (!source.startsWith(APPLICATION_ROOT) && !source.startsWith(API_SOURCE_ROOT)) return true;
  // Application Port的类型签名（例如TraceEmitter）没有可执行函数体，因而在静态
  // 调用图中不可能间接进入Operation。API自己声明的callback类型仍不放行。
  return (
    allowApplicationTypePort &&
    source.startsWith(APPLICATION_ROOT) &&
    (ts.isFunctionTypeNode(declaration) ||
      ts.isCallSignatureDeclaration(declaration) ||
      ts.isMethodSignature(declaration))
  );
}

function directCallDeclarations(call, checker) {
  const callee = normalizedCalleeExpression(call.expression);
  const symbol = ts.isIdentifier(callee)
    ? actualSymbol(checker, callee)
    : ts.isPropertyAccessExpression(callee)
      ? actualSymbol(checker, callee.name)
      : undefined;
  return symbol?.declarations ?? [];
}

function applicationUtilityIsOrdinary(
  declaration,
  checker,
  state = { visiting: new Set(), memo: new Map() },
) {
  const callable = callableDeclaration(declaration);
  if (callable === undefined) return false;
  const key = declarationKey(declaration);
  if (state.memo.has(key)) return state.memo.get(key);
  if (state.visiting.has(key)) return true;
  state.visiting.add(key);
  let ordinary = true;
  visitCallableCalls(callable, (call) => {
    if (!ordinary) return;
    const callee = normalizedCalleeExpression(call.expression);
    if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) {
      ordinary = false;
      return;
    }
    const targets = directCallDeclarations(call, checker).filter(
      (target) => callableDeclaration(target) !== undefined,
    );
    if (targets.length === 0) {
      ordinary = isProvablyOrdinaryCall(call, checker, {
        allowApplicationTypePort: false,
      });
      return;
    }
    for (const target of targets) {
      const source = target.getSourceFile().fileName;
      if (source.startsWith(API_SOURCE_ROOT)) {
        ordinary = false;
        return;
      }
      if (
        source.startsWith(APPLICATION_ROOT) &&
        (isApplicationOperationDeclaration(checker, target) ||
          !applicationUtilityIsOrdinary(target, checker, state))
      ) {
        ordinary = false;
        return;
      }
    }
  });
  state.visiting.delete(key);
  state.memo.set(key, ordinary);
  return ordinary;
}

/**
 * 每个CallExpression只能从这一个出口分类。静态Application Operation记录，API helper
 * 进入有界调用图，有真实外部signature且不在Application/API责任根的调用才允许忽略；
 * 其他动态、间接或混合目标统一失败关闭。
 */
function classifyCallExpression(call, checker, bindings) {
  const callee = normalizedCalleeExpression(call.expression);
  if (ts.isElementAccessExpression(callee) || ts.isCallExpression(callee)) {
    return {
      kind: "unknown",
      reason: `动态或间接callee ${normalizedDeclaration(callee)}`,
    };
  }
  const value = staticCallableValue(callee, checker, bindings);
  if (value.kind === "unknown") {
    return isProvablyOrdinaryCall(call, checker)
      ? { kind: "ordinary" }
      : { kind: "unknown", reason: value.reason };
  }
  if (value.kind === "ordinary") return { kind: "ordinary" };
  if (value.kind !== "callable") {
    return { kind: "unknown", reason: "callee是非函数callback对象" };
  }

  const application = [];
  const helpers = [];
  let ordinaryCount = 0;
  for (const target of value.declarations) {
    const source = target.getSourceFile().fileName;
    if (source.startsWith(APPLICATION_ROOT)) {
      if (!isApplicationOperationDeclaration(checker, target)) {
        if (applicationUtilityIsOrdinary(target, checker)) ordinaryCount += 1;
        else {
          return {
            kind: "unknown",
            reason: `Application callable无法证明不进入Operation：${normalizedDeclaration(target)}`,
          };
        }
        continue;
      }
      application.push(target);
      continue;
    }
    if (source.startsWith(API_SOURCE_ROOT)) {
      const callable = callableDeclaration(target);
      if (callable === undefined) {
        return { kind: "unknown", reason: "API helper不是静态可调用声明" };
      }
      helpers.push(callable);
      continue;
    }
    ordinaryCount += 1;
  }

  const categories =
    Number(application.length > 0) + Number(helpers.length > 0) + Number(ordinaryCount > 0);
  if (categories !== 1) {
    return { kind: "unknown", reason: "callee存在混合或空的静态目标" };
  }
  if (application.length > 0) return { kind: "application", declarations: application };
  if (helpers.length > 0) return { kind: "helper", declarations: helpers };
  return { kind: "ordinary" };
}

/**
 * Route只提供闭包根。这里沿同文件函数、变量函数和已解析import helper收敛，最终以
 * TypeScript resolved symbol判定真实Application operation；递归、环和重复调用由seen稳定去重。
 */
function operationsInHandler(handler, checker) {
  const operations = new Set();
  const queue = [{ declaration: handler, bindings: new Map() }];
  const seen = new Set();
  while (queue.length > 0) {
    const { declaration, bindings } = queue.pop();
    const key = frameKey(declaration, bindings);
    if (seen.has(key)) continue;
    seen.add(key);
    const callableRoot = callableDeclaration(declaration) ?? declaration;
    visitCallableCalls(callableRoot, (node) => {
      const classification = classifyCallExpression(node, checker, bindings);
      if (classification.kind === "unknown") {
        throw new Error(
          `公开route包含无法静态解析的动态调用：${normalizedDeclaration(normalizedCalleeExpression(node.expression))}（${classification.reason}）`,
        );
      }
      if (classification.kind === "ordinary") {
        return;
      }
      if (classification.kind === "application") {
        for (const target of classification.declarations) {
          const operationSymbol = actualSymbol(checker, target.name ?? target);
          const operation = operationSymbol?.getName();
          if (operation !== undefined && !["ApplicationError", "notFound"].includes(operation)) {
            operations.add(operation);
          }
        }
        return;
      }
      for (const callable of classification.declarations) {
        const nestedBindings = new Map(bindings);
        for (const [index, parameter] of callable.parameters.entries()) {
          const argument = node.arguments[index];
          const argumentValue =
            argument === undefined
              ? parameter.initializer === undefined
                ? unknownCallable(`callback参数 ${String(index + 1)} 缺失`)
                : staticCallableValue(parameter.initializer, checker, bindings)
              : staticCallableValue(argument, checker, bindings);
          bindName(checker, parameter.name, argumentValue, nestedBindings);
        }
        queue.push({ declaration: callable, bindings: nestedBindings });
      }
    });
  }
  return [...operations].sort();
}

function bindSuccessfulResponsesToOperations(responses, operationContracts) {
  const applicationResultSignatureSha256 = sha256(
    JSON.stringify(
      operationContracts
        .map((entry) => ({ operation: entry.operation, signatureSha256: entry.signatureSha256 }))
        .sort((left, right) => left.operation.localeCompare(right.operation)),
    ),
  );
  return responses.map((response) => ({
    ...response,
    applicationResultSignatureSha256,
  }));
}

export function assertResolvedRouteOperationsForTest(operations, unresolvedDynamicCalls = []) {
  if (unresolvedDynamicCalls.length > 0) {
    throw new Error(`公开route包含无法静态解析的动态调用：${unresolvedDynamicCalls.join(", ")}`);
  }
  if (!Array.isArray(operations)) {
    throw new Error("公开route operation闭包无效");
  }
  return [...new Set(operations)].sort();
}

export function applicationOperationsFromFixtureForTest({ route, helper, application }) {
  const paths = {
    route: join(API_SOURCE_ROOT, "product-routes/fixture-route.ts"),
    helper: join(API_SOURCE_ROOT, "product-routes/fixture-helper.ts"),
    application: join(APPLICATION_ROOT, "fixture-use-cases.ts"),
  };
  const sources = new Map([
    [paths.route, route],
    [paths.helper, helper],
    [paths.application, application],
  ]);
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => sources.has(path) || originalFileExists(path);
  host.readFile = (path) => sources.get(path) ?? originalReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    sources.has(path)
      ? ts.createSourceFile(path, sources.get(path), languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });
  const file = program.getSourceFile(paths.route);
  if (file === undefined) throw new Error("fixture route无法解析");
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
  if (handler === undefined) throw new Error("fixture缺少handler函数");
  return operationsInHandler(handler, program.getTypeChecker());
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
  const fallback = {
    identity: `application-result:${operation}`,
    schemaVersions: [],
    // 并非所有历史用例都有显式ResponseSchema。返回类型和return表达式的摘要让推断
    // 类型/包装对象变化进入compat diff，同时不把内部类型或实现正文写进公共Manifest。
    signatureSha256: sha256(
      JSON.stringify({ returnType, returnExpressions: returnExpressions.sort() }),
    ),
  };
  return {
    operation,
    responseSchemas: [...responseSchemas].sort(),
    fallback,
    signatureSha256: fallback.signatureSha256,
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
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return ts.createProgram({
    rootNames: [
      ...new Set([
        ...parsed.fileNames,
        join(CONTRACTS_ROOT, "public.ts"),
        join(APPLICATION_ROOT, "index.ts"),
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
      responseSchemas:
        contract.successfulResponses.length > 0
          ? contract.successfulResponses.map((response, index) => ({
              identity: `response-expression:${method} ${path.text}:${String(index + 1)}`,
              schemaVersions: [],
              signatureSha256: response.signatureSha256,
            }))
          : [
              {
                identity: `inline-response:${method} ${path.text}`,
                schemaVersions: [],
                signatureSha256: sha256(normalizedDeclaration(handler)),
              },
            ],
      successfulResponses: contract.successfulResponses,
      applicationOperations: [],
      applicationOperationContracts: [],
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
      const operations = operationsInHandler(handler, checker);
      const contract = routeContract(handler, checker, schemas);
      const requestNames = new Set([
        ...contract.pathParameters.map((entry) => entry.schema.identity),
        ...contract.query.schemas.map((entry) => entry.identity),
        ...contract.body.schemas.map((entry) => entry.identity),
      ]);
      const derivedResponseNames = new Set(contract.responseSchemaNames);
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
        pathParameters: contract.pathParameters,
        query: contract.query,
        body: contract.body,
        requestSchemas: [...requestNames].sort().map((name) => schemaReference(name, schemas)),
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
        successfulResponses: bindSuccessfulResponsesToOperations(
          contract.successfulResponses,
          operationContracts,
        ),
        applicationOperations: operations,
        applicationOperationContracts: operationContracts.map((entry) => ({
          operation: entry.operation,
          responseSchemas: entry.responseSchemas,
          signatureSha256: entry.signatureSha256,
        })),
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
      if (
        !nested.getSourceFile().fileName.startsWith(allowedRoot) ||
        nested.getSourceFile().fileName.includes(`${sep}node_modules${sep}`)
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
      routeContractExtraction: "request-helper-operation-and-success-response-dataflow.v3",
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

const API_SURFACE_NORMALIZERS = Object.freeze({
  "chat-public-api-surface.v2": (value) => value,
  "chat-public-api-surface.v3": (value) => value,
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
  const normalized = structuredClone(route);
  const upgraded = new Set([fromExtraction, toExtraction]);
  if (
    upgraded.has("request-source-and-success-response-dataflow.v2") &&
    upgraded.has("request-helper-operation-and-success-response-dataflow.v3")
  ) {
    for (const response of normalized.successfulResponses ?? []) {
      delete response.applicationResultSignatureSha256;
    }
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
