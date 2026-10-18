import ts from 'typescript';

import { parseTypeScriptSource } from '../parse-typescript-source';
import type { ComponentIR } from '../../ir/component';
import type { OptimizationPassIR } from './types';

/**
 * 表达式级优化辅助。
 *
 * 这个模块服务于优化阶段中最细粒度的一层工作：在不改变表达式语义的前提下，
 * 尝试把可静态确定的 computed / signal 调用内联为更直接的字面量或子表达式。
 *
 * 这里的策略比较保守，重点是“只做确定性很高的替换”：
 * - 通过正则匹配替换 `foo()` / `this.foo()` 这类简单调用；
 * - 通过 TypeScript AST 解析与一个小型求值器，折叠少量安全的常量表达式；
 * - 如果发现信号可能在其他位置被写入，或表达式无法可靠求值，就直接放弃优化。
 *
 * 这样可以在维持实现简单和语义安全的同时，为后续代码生成减少运行时求值成本。
 *
 * 从优化流水线位置上看，它更像一个“轻量纯表达式折叠器”：
 * - 输入是组件分析结果与待优化的源码表达式；
 * - 输出仍然是源码表达式字符串，而不是新的 AST 结构；
 * - 因此这里的每一步都围绕“能否安全替换字符串”展开，而不是做大范围重写。
 */
const escapeRegExp = (value: string): string => {
  // 动态拼正则前先转义元字符，避免 signal/computed 名称污染匹配模式。
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const replaceComputedCalls = (
  expression: string,
  computedName: string,
  computedExpression: string
): string => {
  // 同时覆盖 `this.foo()` 与裸 `foo()` 两种调用风格。
  const thisPattern = new RegExp(`\\bthis\\.${escapeRegExp(computedName)}\\(\\)`, 'g');
  const barePattern = new RegExp(`\\b${escapeRegExp(computedName)}\\(\\)`, 'g');

  return expression
    .replace(thisPattern, `(${computedExpression})`)
    .replace(barePattern, `(${computedExpression})`);
};

export const replaceSignalCalls = (
  expression: string,
  signalName: string,
  foldedValue: string
): string => {
  // signal 调用的替换规则与 computed 保持一致，便于后续统一折叠。
  const thisPattern = new RegExp(`\\bthis\\.${escapeRegExp(signalName)}\\(\\)`, 'g');
  const barePattern = new RegExp(`\\b${escapeRegExp(signalName)}\\(\\)`, 'g');

  return expression
    .replace(thisPattern, `(${foldedValue})`)
    .replace(barePattern, `(${foldedValue})`);
};

export const tryEvaluateConstantExpression = (expression: string): string | null => {
  try {
    // 先把任意表达式包进一条合法的变量声明，再交给 TS parser 做结构校验。
    const sourceFile = parseTypeScriptSource(
      '__lania_constant_expression__.ts',
      `const __lania_expr__ = (${expression});`
    );
    const statement = sourceFile.statements[0];

    if (
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.declarationList.declarations.length !== 1
    ) {
      return null;
    }

    const initializer = statement.declarationList.declarations[0]?.initializer;

    if (!initializer) {
      return null;
    }

    const evaluate = (node: ts.Expression): string | number | boolean | null | undefined => {
      if (ts.isParenthesizedExpression(node)) {
        // 外层括号不影响常量值，直接继续递归。
        return evaluate(node.expression);
      }

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }

      if (ts.isNumericLiteral(node)) {
        return Number(node.text);
      }

      if (node.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
      }

      if (node.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
      }

      if (node.kind === ts.SyntaxKind.NullKeyword) {
        return null;
      }

      if (ts.isPrefixUnaryExpression(node)) {
        const value = evaluate(node.operand);

        if (typeof value === 'number') {
          // 这里只支持与数值常量直接相关的一元运算，避免引入更复杂的 JS 语义。
          switch (node.operator) {
            case ts.SyntaxKind.MinusToken:
              return -value;
            case ts.SyntaxKind.PlusToken:
              return +value;
          }
        }

        if (typeof value === 'boolean' && node.operator === ts.SyntaxKind.ExclamationToken) {
          return !value;
        }

        return undefined;
      }

      if (ts.isBinaryExpression(node)) {
        const left = evaluate(node.left);
        const right = evaluate(node.right);

        if (left === undefined || right === undefined) {
          // 任一侧无法确定时，整棵二元表达式都放弃折叠。
          return undefined;
        }

        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken:
            // `+` 同时兼顾字符串拼接与数字加法，因此保留最贴近 JS 的分支行为。
            return typeof left === 'string' || typeof right === 'string'
              ? `${left}${right}`
              : Number(left) + Number(right);
          case ts.SyntaxKind.MinusToken:
            return Number(left) - Number(right);
          case ts.SyntaxKind.AsteriskToken:
            return Number(left) * Number(right);
          case ts.SyntaxKind.SlashToken:
            return Number(left) / Number(right);
          case ts.SyntaxKind.PercentToken:
            return Number(left) % Number(right);
          case ts.SyntaxKind.AmpersandAmpersandToken:
            return Boolean(left) && Boolean(right);
          case ts.SyntaxKind.BarBarToken:
            return Boolean(left) || Boolean(right);
          case ts.SyntaxKind.EqualsEqualsEqualsToken:
            return left === right;
          case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            return left !== right;
          default:
            return undefined;
        }
      }

      return undefined;
    };

    const result = evaluate(initializer);

    if (result === undefined) {
      return null;
    }

    // 统一返回字符串形式，方便直接嵌回源码模板。
    return String(result);
  } catch {
    // 非法表达式或解析失败时静默回退，不阻断整个优化流程。
    return null;
  }
};

export const applyComputedInlineToExpression = (
  expression: string,
  component: ComponentIR,
  usedComputed: Set<string>
): string => {
  // 逐个 computed 尝试替换，后一个 computed 可以继续作用于前一个替换结果。
  let currentExpression = expression;

  component.computed.forEach((computed) => {
    if (!computed.expression) {
      // 无法拿到纯表达式体的 computed 不参与这里的内联优化。
      return;
    }

    const nextExpression = replaceComputedCalls(
      currentExpression,
      computed.name,
      computed.expression
    );

    if (nextExpression !== currentExpression) {
      // 只有真正发生替换时才记录依赖，避免优化记录里出现无效 computed。
      usedComputed.add(computed.name);
      currentExpression = nextExpression;
    }
  });

  return currentExpression;
};

/**
 * 计算哪些 computed 必须保留成实例字段。
 *
 * computed 内联进模板后通常可以从类里删掉，但只要 effect / 生命周期 / setup 绑定
 * 或另一个保留下来的 computed 还引用它，就必须继续暴露可读句柄，
 * 否则 `this.xxx` 会变成 undefined 而不是 memo。
 */
export const collectRetainedComputedNames = (component: ComponentIR): Set<string> => {
  const names = component.computed.map((computed) => computed.name);

  if (names.length === 0) {
    return new Set<string>();
  }

  const patterns = names.map((name) => ({
    name,
    pattern: new RegExp(`\\bthis\\.${escapeRegExp(name)}\\b`),
  }));

  const collectReferences = (source: string): string[] =>
    patterns.filter((entry) => entry.pattern.test(source)).map((entry) => entry.name);

  const expressions = new Map(
    component.computed.map((computed) => [computed.name, computed.expression ?? ''])
  );
  const retained = new Set<string>();
  const pending = [
    ...component.effects.map((effect) => effect.body ?? ''),
    ...component.lifecycleCallbacks.map((callback) => callback.body ?? ''),
    ...component.setupBindings.flatMap((binding) => [
      binding.body ?? '',
      binding.initializer ?? '',
    ]),
  ].flatMap(collectReferences);

  while (pending.length > 0) {
    const name = pending.pop()!;

    if (retained.has(name)) {
      continue;
    }

    retained.add(name);
    pending.push(...collectReferences(expressions.get(name) ?? ''));
  }

  return retained;
};

export const tryExtractStaticSignalValue = (initializer: string | null): string | null => {
  if (!initializer) {
    return null;
  }

  try {
    // 这里不是直接求值整个 initializer，而是专门识别 `createSignal(<const>)` 模式。
    const sourceFile = parseTypeScriptSource(
      '__lania_static_signal__.ts',
      `const __lania_signal__ = ${initializer};`
    );
    const statement = sourceFile.statements[0];

    if (
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.declarationList.declarations.length !== 1
    ) {
      return null;
    }

    const nextInitializer = statement.declarationList.declarations[0]?.initializer;

    if (
      !nextInitializer ||
      !ts.isCallExpression(nextInitializer) ||
      !ts.isIdentifier(nextInitializer.expression) ||
      nextInitializer.expression.text !== 'createSignal' ||
      nextInitializer.arguments.length !== 1
    ) {
      // 这里只识别最标准的 `createSignal(initial)` 形态，避免误折叠其他工厂函数。
      return null;
    }

    const arg = nextInitializer.arguments[0]!;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return JSON.stringify(arg.text);
    }
    if (ts.isNumericLiteral(arg)) {
      return arg.text;
    }
    if (arg.kind === ts.SyntaxKind.TrueKeyword) {
      return 'true';
    }
    if (arg.kind === ts.SyntaxKind.FalseKeyword) {
      return 'false';
    }
    if (arg.kind === ts.SyntaxKind.NullKeyword) {
      return 'null';
    }
    // 复杂一点的常量再委托给通用表达式求值器尝试折叠。
    return tryEvaluateConstantExpression(arg.getText());
  } catch {
    return null;
  }
};

export const hasSignalWrite = (component: ComponentIR, signalName: string): boolean => {
  // 只要发现可能写入 signal，就不能把它视为全程静态值。
  const writePatterns = [
    new RegExp(`\\bthis\\.${escapeRegExp(signalName)}\\.set\\(`),
    new RegExp(`\\b${escapeRegExp(signalName)}\\.set\\(`),
    new RegExp(`\\bthis\\.${escapeRegExp(signalName)}\\s*=`),
  ];
  const sources = [
    ...component.effects.map((effect) => effect.body),
    ...component.lifecycleCallbacks.map((callback) => callback.body ?? ''),
    ...component.setupBindings.flatMap((binding) => [binding.body ?? '', binding.initializer ?? '']),
  ].filter((source): source is string => typeof source === 'string');

  // 这里不追求完整数据流分析，只做“命中即保守放弃”的写入探测。
  return sources.some((source) => writePatterns.some((pattern) => pattern.test(source)));
};

export const buildStaticSignalFoldMap = (
  component: ComponentIR,
  usedSignals: ReadonlySet<string>
): Record<string, string> => {
  // 输出只包含“可静态提取、未被写入、且当前轮未显式占用”的 signal 常量。
  return Object.fromEntries(
    component.signals
      .map((signal) => {
        const folded = tryExtractStaticSignalValue(signal.initializer);

        // 被显式使用、可能被写入或根本无法静态提取的 signal 都不进入折叠表。
        if (!folded || hasSignalWrite(component, signal.name) || usedSignals.has(signal.name)) {
          return null;
        }

        return [signal.name, folded] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null)
  );
};

export const applyStaticSignalInlineToExpression = (
  expression: string,
  staticSignals: Record<string, string>,
  optimization: OptimizationPassIR
): string => {
  // 常量 signal 折叠在表达式层做最后一轮替换，并把命中记录回 optimization IR。
  let currentExpression = expression;

  Object.entries(staticSignals).forEach(([signalName, foldedValue]) => {
    const nextExpression = replaceSignalCalls(currentExpression, signalName, foldedValue);

    if (nextExpression !== currentExpression) {
      if (
        !optimization.staticSignalFolds.some(
          (record) => record.signal === signalName && record.folded === foldedValue
        )
      ) {
        // 优化记录只保留唯一条目，便于调试时回看实际发生过哪些折叠。
        optimization.staticSignalFolds.push({
          signal: signalName,
          folded: foldedValue,
        });
      }

      currentExpression = nextExpression;
    }
  });

  return currentExpression;
};
