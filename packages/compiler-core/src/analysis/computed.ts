import ts from 'typescript';

import { parseTypeScriptSource } from '../transform/parse-typescript-source';

/**
 * 计算属性复杂度分析。
 *
 * 目标是区分可直接内联的简单 getter 与必须拆成 updater-chain
 * 的复杂 getter，并抽取其中的 signal 依赖。
 *
 * 这一步本质上是在回答两个问题：
 * 1. 这个 getter 能否被当成“纯表达式”直接塞回模板或其他表达式里；
 * 2. 如果不能，后续最少需要监听哪些 signal 风格读取来驱动更新。
 *
 * 因为后续 codegen 对 `inline` 和 `updater_chain` 两条路径的处理差异很大，
 * 所以这里会尽量早地给出保守但稳定的判断，而不是在更后面的阶段再反复猜测。
 */

export type ComputedComplexity = 'simple' | 'complex';
export type ComputedStrategy = 'inline' | 'updater_chain';

export interface ComputedDependency {
  kind: 'this-signal-call' | 'identifier-call';
  name: string;
  text: string;
}

export interface ComputedAnalysisResult {
  name: string;
  ownerName: string | null;
  complexity: ComputedComplexity;
  strategy: ComputedStrategy;
  expressionText: string | null;
  dependencies: ComputedDependency[];
  reasons: string[];
}

const isSimpleThisSignalCall = (expression: ts.Expression): boolean => {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (expression.arguments.length > 0) {
    return false;
  }

  return (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  );
};

const isSimpleIdentifierSignalCall = (expression: ts.Expression): boolean => {
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 0 &&
    ts.isIdentifier(expression.expression)
  );
};

const collectDependencies = (expression: ts.Expression): ComputedDependency[] => {
  // 同一表达式里多次读取同一个 signal 时，只保留一份依赖描述，避免后续链路重复登记。
  const deps = new Map<string, ComputedDependency>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 0) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const name = node.expression.name.text;
        deps.set(`this:${name}`, {
          kind: 'this-signal-call',
          name,
          text: node.getText(),
        });
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        deps.set(`id:${name}`, {
          kind: 'identifier-call',
          name,
          text: node.getText(),
        });
      }
    }

    // 继续深度遍历，收集表达式树里所有 signal 风格读取。
    ts.forEachChild(node, visit);
  };

  visit(expression);
  return [...deps.values()];
};

const isSimpleComputedExpression = (
  node: ts.Node,
  reasons: string[]
): boolean => {
  // 字面量、this 与标识符都可以直接视为可内联的原子表达式。
  if (
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return true;
  }

  if (ts.isIdentifier(node)) {
    return true;
  }

  if (ts.isParenthesizedExpression(node)) {
    return isSimpleComputedExpression(node.expression, reasons);
  }

  if (ts.isPropertyAccessExpression(node)) {
    return isSimpleComputedExpression(node.expression, reasons);
  }

  if (ts.isElementAccessExpression(node)) {
    return (
      isSimpleComputedExpression(node.expression, reasons) &&
      isSimpleComputedExpression(node.argumentExpression, reasons)
    );
  }

  if (ts.isCallExpression(node)) {
    const isSimpleCall =
      isSimpleThisSignalCall(node) || isSimpleIdentifierSignalCall(node);

    if (!isSimpleCall) {
      // 只允许零参 signal 读取，其他调用统一降级为复杂表达式。
      reasons.push(`call expression "${node.getText()}" is not a signal-style read`);
      return false;
    }

    return true;
  }

  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return isSimpleComputedExpression(node.operand, reasons);
  }

  if (ts.isBinaryExpression(node)) {
    return (
      isSimpleComputedExpression(node.left, reasons) &&
      isSimpleComputedExpression(node.right, reasons)
    );
  }

  if (ts.isConditionalExpression(node)) {
    return (
      isSimpleComputedExpression(node.condition, reasons) &&
      isSimpleComputedExpression(node.whenTrue, reasons) &&
      isSimpleComputedExpression(node.whenFalse, reasons)
    );
  }

  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((span) =>
      isSimpleComputedExpression(span.expression, reasons)
    );
  }

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return true;
  }

  reasons.push(`node kind "${ts.SyntaxKind[node.kind]}" requires updater-chain lowering`);
  return false;
};

const getGetterBodyExpression = (
  accessor: ts.GetAccessorDeclaration,
  reasons: string[]
): ts.Expression | null => {
  const body = accessor.body;

  if (!body) {
    reasons.push('getter body is missing');
    return null;
  }

  if (body.statements.length !== 1) {
    // 目前只接受最简单的 `return expr` 形式，便于后续策略判断。
    reasons.push('getter contains multiple statements');
    return null;
  }

  const [statement] = body.statements;

  if (!ts.isReturnStatement(statement) || !statement.expression) {
    reasons.push('getter body is not a single return statement');
    return null;
  }

  return statement.expression;
};

export const analyzeComputedGetter = (
  accessor: ts.GetAccessorDeclaration,
  sourceFile: ts.SourceFile
): ComputedAnalysisResult => {
  const reasons: string[] = [];
  const expression = getGetterBodyExpression(accessor, reasons);
  const owner = accessor.parent;
  // getter 所属类名只用于分析结果归档与调试展示，不参与复杂度判断本身。
  const ownerName =
    ts.isClassDeclaration(owner) && owner.name ? owner.name.text : null;

  if (!expression) {
    // 语法不满足简化约束时，直接回退到保守策略。
    return {
      name: accessor.name.getText(sourceFile),
      ownerName,
      complexity: 'complex',
      strategy: 'updater_chain',
      expressionText: null,
      dependencies: [],
      reasons,
    };
  }

  const simple = isSimpleComputedExpression(expression, reasons);

  return {
    name: accessor.name.getText(sourceFile),
    ownerName,
    complexity: simple ? 'simple' : 'complex',
    strategy: simple ? 'inline' : 'updater_chain',
    expressionText: expression.getText(sourceFile),
    dependencies: collectDependencies(expression),
    reasons,
  };
};

export const analyzeComputedSource = (
  fileName: string,
  source: string,
  getterName: string
): ComputedAnalysisResult => {
  // 这里走“源码字符串 -> AST -> 定位 getter”的路径，方便单测或独立分析工具直接复用。
  const ast = parseTypeScriptSource(fileName, source);
  let matchedAccessor: ts.GetAccessorDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isGetAccessorDeclaration(node) &&
      node.name.getText(ast) === getterName
    ) {
      matchedAccessor = node;
      return;
    }

    // 遍历整棵 AST，直到命中目标 getter。
    ts.forEachChild(node, visit);
  };

  visit(ast);

  if (!matchedAccessor) {
    return {
      name: getterName,
      ownerName: null,
      complexity: 'complex',
      strategy: 'updater_chain',
      expressionText: null,
      dependencies: [],
      reasons: [`getter "${getterName}" was not found`],
    };
  }

  return analyzeComputedGetter(matchedAccessor, ast);
};
