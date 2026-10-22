import ts from 'typescript';

import { parseTypeScriptSource } from '../../transform/parse-typescript-source';
import type { ExpressionDependency } from './types';
import { isAssignmentOperatorToken } from './utils';

/**
 * 表达式依赖分析。
 *
 * 这个模块负责把模板表达式、computed 表达式、effect 代码块等源码片段解析成 TS AST，
 * 再从中提取“读取了哪些 signal / prop / store 路径”的依赖记录。
 *
 * 它是依赖分析阶段最底层的通用能力，核心用途包括：
 * - 识别 `foo()`、`this.foo()` 这类响应式读取调用；
 * - 识别 `this.prop` 这类属性读取，但避开写入与调用场景；
 * - 识别 `this.store.user.name` / `this.store.list[0]` 这类深路径 store 读取；
 * - 对多个来源的依赖结果做去重合并，供上层生成 slot / updater 映射。
 *
 * 这里的实现偏“语义保守”：
 * 只在能够较可靠区分读取与写入时才记录依赖，避免把无关节点误归入响应式依赖图。
 */
export const getDependencyAccessPath = (expression: ts.Node): string[] => {
  const accessPath: string[] = [];
  let current: ts.Node = expression;

  // 从调用点开始向外追踪连续的 `.foo` / `[bar]` 访问，拼成深层读取路径。
  while (true) {
    const parent = current.parent;

    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current
    ) {
      accessPath.push(parent.name.text);
      current = parent;
      continue;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      accessPath.push(parent.argumentExpression.getText());
      current = parent;
      continue;
    }

    break;
  }

  return accessPath;
};

const isAccessChainTerminal = (node: ts.Node): boolean => {
  const parent = node.parent;
  // 只有处在访问链末端的节点才参与 store 路径识别，避免中间片段被重复记录。
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
    (ts.isElementAccessExpression(parent) && parent.expression === node)
  );
};

const extractStorePathRead = (
  node: ts.Node,
  storeNames: ReadonlySet<string>
): { storeName: string; accessPath: string[] } | null => {
  if (!isAccessChainTerminal(node)) {
    return null;
  }

  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return null;
  }

  const segments: string[] = [];
  let current: ts.Node = node;
  let storeName: string | null = null;

  // 从访问链尾部反向回溯，直到找到以 `this.<store>` 为根的路径。
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.kind === ts.SyntaxKind.ThisKeyword) {
        storeName = current.name.text;
        break;
      }

      segments.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    const arg = current.argumentExpression;
    if (ts.isNumericLiteral(arg) || ts.isStringLiteral(arg)) {
      segments.unshift(arg.text);
    } else {
      segments.unshift(`[${arg.getText()}]`);
    }
    current = current.expression;
  }

  if (!storeName || !storeNames.has(storeName)) {
    return null;
  }

  // `store.set(...)` / `store.peek()` 是句柄方法，不属于数据路径读取。
  if (
    segments.length === 1 &&
    (segments[0] === 'set' || segments[0] === 'peek')
  ) {
    return null;
  }

  return { storeName, accessPath: segments };
};

const isPropertyRead = (node: ts.PropertyAccessExpression): boolean => {
  const parent = node.parent;

  if (ts.isCallExpression(parent) && parent.expression === node) {
    // `this.foo()` 属于调用语义，不应当再按属性读取重复记一次。
    return false;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    isAssignmentOperatorToken(parent.operatorToken.kind)
  ) {
    return false;
  }

  if (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === node &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    // `++this.foo` / `this.foo++` / `--this.foo` 属于写入语义；
    // 其余一元运算符（`!`、`-`、`typeof` 等）仍然只是读取，必须计入依赖。
    return false;
  }

  return true;
};

const isUntrackCallee = (expression: ts.LeftHandSideExpression): boolean => {
  // `untrack(...)` 中的读取不应进入依赖图，因此这里先识别它的调用形式。
  return (
    (ts.isIdentifier(expression) && expression.text === 'untrack') ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'untrack')
  );
};

const getUntrackCallback = (
  node: ts.CallExpression
): ts.ArrowFunction | ts.FunctionExpression | null => {
  if (!isUntrackCallee(node.expression)) {
    return null;
  }

  const callback = node.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return null;
  }

  return callback;
};

const collectDependencyCalls = (
  root: ts.Node,
  propertyReadNames: ReadonlySet<string> = new Set<string>(),
  storeNames: ReadonlySet<string> = new Set<string>()
): ExpressionDependency[] => {
  const dependencies = new Map<string, ExpressionDependency>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const untrackCallback = getUntrackCallback(node);
      if (untrackCallback) {
        // `untrack` 整个回调都跳过，保证内部读取不会触发订阅。
        return;
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length === 0) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const name = node.expression.name.text;
        const accessPath = getDependencyAccessPath(node);
        dependencies.set(`this:${name}:${accessPath.join('.')}`, {
          kind: 'this-signal-call',
          name,
          text: node.getText(),
          accessPath,
        });
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        // 兼容 `this.store.user()` 这类“this 下再挂一层命名空间”的 signal 调用形式。
        const owner = node.expression.expression.name.text;
        const member = node.expression.name.text;
        const name = `${owner}.${member}`;
        const accessPath = getDependencyAccessPath(node);
        dependencies.set(`this:${name}:${accessPath.join('.')}`, {
          kind: 'this-signal-call',
          name,
          text: node.getText(),
          accessPath,
        });
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const accessPath = getDependencyAccessPath(node);
        dependencies.set(`id:${name}:${accessPath.join('.')}`, {
          kind: 'identifier-call',
          name,
          text: node.getText(),
          accessPath,
        });
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'value' &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      isPropertyRead(node)
    ) {
      // `this.count.value` 是新的 signal / computed 读取形态，等价于旧的 `this.count()`。
      const name = node.expression.name.text;
      const accessPath = getDependencyAccessPath(node.expression);
      dependencies.set(`this:${name}:${accessPath.join('.')}`, {
        kind: 'this-signal-call',
        name,
        text: node.getText(),
        accessPath,
      });
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      propertyReadNames.has(node.name.text) &&
      isPropertyRead(node)
    ) {
      dependencies.set(`prop:${node.name.text}`, {
        kind: 'this-property-read',
        name: node.name.text,
        text: node.getText(),
        accessPath: getDependencyAccessPath(
          node as unknown as ts.CallExpression
        ),
      });
    }

    const storeRead = extractStorePathRead(node, storeNames);
    if (storeRead) {
      dependencies.set(
        `store:${storeRead.storeName}:${storeRead.accessPath.join('.')}`,
        {
          kind: 'store-path-read',
          name: storeRead.storeName,
          text: node.getText(),
          accessPath: storeRead.accessPath,
        }
      );
    }

    // 其余节点继续递归下探，形成一次完整 AST 扫描。
    ts.forEachChild(node, visit);
  };

  visit(root);
  return [...dependencies.values()];
};

export const parseExpressionNode = (expression: string): ts.Expression => {
  // 把任意表达式包进变量初始化语句，借助 TS parser 复用现成语法能力。
  const ast = parseTypeScriptSource(
    '__lania_expression__.tsx',
    `const __lania_expr__ = (${expression});`
  );
  const statement = ast.statements[0];

  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    throw new Error(`Failed to parse expression: ${expression}`);
  }

  const declaration = statement.declarationList.declarations[0];
  if (!declaration?.initializer) {
    throw new Error(`Expression initializer is missing: ${expression}`);
  }

  return declaration.initializer;
};

export const parseBlockNode = (body: string): ts.Block => {
  // 代码块同样包进一个函数体中解析，这样 effect / lifecycle body 都能统一处理。
  const ast = parseTypeScriptSource(
    '__lania_block__.tsx',
    `function __lania_effect__() {\n${body}\n}`
  );
  const statement = ast.statements[0];

  if (!statement || !ts.isFunctionDeclaration(statement) || !statement.body) {
    throw new Error('Failed to parse block body.');
  }

  return statement.body;
};

export const mergeDependencies = (
  ...groups: ExpressionDependency[][]
): ExpressionDependency[] => {
  const merged = new Map<string, ExpressionDependency>();
  groups.flat().forEach((dependency) => {
    // 以 kind + name + path 作为稳定键，避免不同来源的同一依赖重复入表。
    merged.set(
      `${dependency.kind}:${dependency.name}:${dependency.accessPath.join('.')}`,
      dependency
    );
  });
  return [...merged.values()];
};

export const analyzeExpressionDependencies = (
  expression: string,
  propertyReadNames?: ReadonlySet<string>,
  storeNames?: ReadonlySet<string>
): ExpressionDependency[] => {
  // 表达式分析直接走 `parseExpressionNode`，避免 block 语义把局部语句也带进来。
  return collectDependencyCalls(
    parseExpressionNode(expression),
    propertyReadNames,
    storeNames
  );
};

export const analyzeBlockDependencies = (
  body: string,
  propertyReadNames?: ReadonlySet<string>,
  storeNames?: ReadonlySet<string>
): ExpressionDependency[] => {
  // block 分析保留语句级上下文，适合 effect / lifecycle / setup statement 这类场景。
  return collectDependencyCalls(
    parseBlockNode(body),
    propertyReadNames,
    storeNames
  );
};
