/**
 * 函数组件绑定重写器。
 *
 * 函数组件源码在进入 compiler-core 后，后续阶段默认面对的是一套统一的“组件实例成员模型”。
 * 换句话说，下游并不关心一个值在源码里原本来自局部变量、signal、props 别名，
 * 还是上下文里的 `emit` / `useContext` 辅助函数；它只希望稳定地读取 `this.xxx`
 * 及相关成员访问形式。
 *
 * 这个文件承担的是“引用重写”这一层适配工作：
 * 1. 把 signal / computed / 普通 setup 绑定统一改成 `this.xxx` 访问；
 * 2. 把 signal setter、emit、context helper 等特殊调用改成实例模型可消费的形式；
 * 3. 正确处理块级作用域、嵌套函数、参数和解构带来的同名遮蔽，避免误改局部变量；
 * 4. 保持执行顺序、求值次数和源码语义不变，只替换引用方式本身。
 *
 * 实现上依赖 TypeScript transformer 精准修改 AST，再重新打印成字符串，供 setup、
 * effect、生命周期与模板表达式等多个下游阶段复用。因为这一步直接决定后续生成代码的
 * 成员访问形态，所以注释会重点标出“哪些节点能改、哪些节点必须跳过、为什么要先判断遮蔽”。
 */
import ts from 'typescript';

import {
  parseTypeScriptSource,
  type TemplateNode,
} from '@lania-v/compiler-core';

import { printer } from './helpers';
import type { FunctionBindingContext } from './types';

/** 判断标识符是否处在声明位置，避免把定义本身也重写掉。 */
const isDeclarationIdentifier = (node: ts.Identifier): boolean => {
  return (
    (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
    (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) ||
    (ts.isParameter(node.parent) && node.parent.name === node) ||
    (ts.isBindingElement(node.parent) && node.parent.name === node)
  );
};

/** 判断标识符是否是属性名位置，避免误改对象 key 与成员名。 */
const isPropertyNameIdentifier = (node: ts.Identifier): boolean => {
  return (
    (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
    (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
    (ts.isMethodDeclaration(node.parent) && node.parent.name === node) ||
    (ts.isJsxAttribute(node.parent) && node.parent.name === node) ||
    // JSX 标签名（`<p>` 这类原生标签）不是变量引用，改写会直接破坏模板结构。
    ((ts.isJsxOpeningElement(node.parent) ||
      ts.isJsxClosingElement(node.parent) ||
      ts.isJsxSelfClosingElement(node.parent)) &&
      node.parent.tagName === node) ||
    ts.isShorthandPropertyAssignment(node.parent)
  );
};

const isAlreadyThisMember = (node: ts.Identifier): boolean => {
  // `this.foo` 里的 `foo` 已经是目标形态，避免再次包裹成非法访问。
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
};

const collectBindingNames = (name: ts.BindingName, target: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
    return;
  }

  name.elements.forEach((element) => {
    if (ts.isOmittedExpression(element)) {
      // 跳过数组解构里的空槽，例如 `[foo, , bar]`。
      return;
    }

    collectBindingNames(element.name, target);
  });
};

// 每进入一层块级或函数作用域，都先收集本地声明，避免误改被遮蔽的同名变量。
const collectDirectScopeNames = (node: ts.Node): Set<string> => {
  const names = new Set<string>();
  const addFromStatement = (statement: ts.Statement) => {
    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => {
        collectBindingNames(declaration.name, names);
      });
      return;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      return;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
  };

  if (ts.isSourceFile(node)) {
    node.statements.forEach(addFromStatement);
    return names;
  }

  if (ts.isBlock(node)) {
    node.statements.forEach(addFromStatement);
    return names;
  }

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    node.parameters.forEach((parameter) => {
      collectBindingNames(parameter.name, names);
    });
  }

  return names;
};

const hasPropAlias = (
  bindings: FunctionBindingContext,
  localName: string
): boolean =>
  bindings.propAliases.has(localName) ||
  Boolean(bindings.propReplacements?.has(localName));

// 解构读取回落到实例 prop getter，避免落成一次性快照。
const readPropReplacement = (
  bindings: FunctionBindingContext,
  localName: string
): ts.Expression => {
  const replacement = bindings.propReplacements?.get(localName);

  if (replacement !== undefined) {
    // 复杂形态（默认值 / 嵌套 / rest）已形成为表达式文本，直接作为源码片段打印。
    return ts.factory.createIdentifier(replacement);
  }

  return ts.factory.createPropertyAccessExpression(
    ts.factory.createThis(),
    bindings.propAliases.get(localName)!
  );
};

// 绑定重写遵循“先判断作用域遮蔽，再按特殊语义分支重写，最后兜底改成实例字段”的顺序。
const createBindingTransformer = (
  bindings: FunctionBindingContext
): ts.TransformerFactory<ts.SourceFile> => {
  return (context) => {
    // 作用域栈用于处理嵌套函数和块中的重名变量，只改写组件顶层可见绑定。
    const scopeStack: Set<string>[] = [];
    const isShadowedByLocalScope = (name: string): boolean => {
      return scopeStack.some((scope) => scope.has(name));
    };
    const visit: ts.Visitor = (node) => {
      if (
        ts.isSourceFile(node) ||
        ts.isBlock(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        // 进入一个新作用域时先入栈，访问完其子树后立即弹栈，保持遮蔽判断准确。
        scopeStack.unshift(collectDirectScopeNames(node));
        const visited = ts.visitEachChild(node, visit, context);
        scopeStack.shift();
        return visited;
      }

      // 优先处理“有特殊读语义的调用形态”，避免后面的标识符兜底分支过早把它们改散。
      // `count()` 这类读取需要改成 `this.count()` 或 `this.total`。
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 0 &&
        ts.isIdentifier(node.expression)
      ) {
        if (isShadowedByLocalScope(node.expression.text)) {
          return ts.visitEachChild(node, visit, context);
        }

        // 编译产物没有 runtime slot scope，插槽内容以 `children` prop 传入，
        // 因此 `bindSlots()` 需要显式接收构造期快照。
        if (node.expression.text === 'bindSlots' && bindings.propAlias) {
          return ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            [ts.factory.createPropertyAccessExpression(ts.factory.createThis(), 'props')]
          );
        }

        if (bindings.computedNames.has(node.expression.text)) {
          // computed 在实例模型里是 memo 字段，读取与 signal 一样保留调用括号。
          return ts.factory.updateCallExpression(
            node,
            ts.factory.createPropertyAccessExpression(
              ts.factory.createThis(),
              node.expression.text
            ),
            node.typeArguments,
            node.arguments
          );
        }

        if (bindings.signalNames.has(node.expression.text)) {
          // signal 读取仍保留“调用取值”约定，只是宿主从局部变量换成实例字段。
          return ts.factory.updateCallExpression(
            node,
            ts.factory.createPropertyAccessExpression(
              ts.factory.createThis(),
              node.expression.text
            ),
            node.typeArguments,
            node.arguments
          );
        }
      }

      // 统一把本地 emit 别名改写成组件实例上的 `this.emit(...)`。
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        bindings.emitAliases.has(node.expression.text)
      ) {
        const nextArguments = node.arguments.map((argument) =>
          ts.visitNode(argument, visit) as ts.Expression
        );
        return ts.factory.updateCallExpression(
          node,
          ts.factory.createPropertyAccessExpression(ts.factory.createThis(), 'emit'),
          node.typeArguments,
          nextArguments
        );
      }

      // 函数组件里的 `useContext(ctx)` 默认绑定当前组件宿主，
      // 用户不需要手动再包一层 `withContextHost(...)`。
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useContext' &&
        node.arguments.length === 1 &&
        !isShadowedByLocalScope(node.expression.text)
      ) {
        const nextArguments = node.arguments.map((argument) =>
          ts.visitNode(argument, visit) as ts.Expression
        );
        return ts.factory.updateCallExpression(
          node,
          node.expression,
          node.typeArguments,
          [...nextArguments, ts.factory.createThis()]
        );
      }

      // 组件体内的两参 `provideContext(Context, value)` 是编译期语法糖，
      // 会被改写成 `provideContext(this, Context, value)`，确保上下文直接挂到当前组件宿主。
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'provideContext' &&
        node.arguments.length === 2 &&
        !isShadowedByLocalScope(node.expression.text)
      ) {
        const nextArguments = node.arguments.map((argument) =>
          ts.visitNode(argument, visit) as ts.Expression
        );
        return ts.factory.updateCallExpression(
          node,
          ts.factory.createIdentifier('provideContext'),
          node.typeArguments,
          [ts.factory.createThis(), ...nextArguments]
        );
      }

      // 兼容 `ctx.emit(...)` 这类上下文访问写法。
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        bindings.emitAliases.has(`${node.expression.expression.text}.${node.expression.name.text}`) &&
        node.expression.name.text === 'emit'
      ) {
        const nextArguments = node.arguments.map((argument) =>
          ts.visitNode(argument, visit) as ts.Expression
        );
        return ts.factory.updateCallExpression(
          node,
          ts.factory.createPropertyAccessExpression(ts.factory.createThis(), 'emit'),
          node.typeArguments,
          nextArguments
        );
      }

      // signal setter 会落到 `this.xxx.set(...)`。
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        bindings.signalSetterToName.has(node.expression.text)
      ) {
        if (isShadowedByLocalScope(node.expression.text)) {
          return ts.visitEachChild(node, visit, context);
        }

        const signalName = bindings.signalSetterToName.get(node.expression.text)!;
        const nextArguments = node.arguments.map((argument) =>
          ts.visitNode(argument, visit) as ts.Expression
        );
        return ts.factory.updateCallExpression(
          node,
          ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createThis(),
              signalName
            ),
            'set'
          ),
          node.typeArguments,
          nextArguments
        );
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (bindings.signalNames.has(node.expression.text) ||
          bindings.computedNames.has(node.expression.text))
      ) {
        if (isShadowedByLocalScope(node.expression.text)) {
          return ts.visitEachChild(node, visit, context);
        }

        // `count.value`、`count.peek` 这类成员访问需要整体前移到 `this.count.xxx`。
        return ts.factory.updatePropertyAccessExpression(
          node,
          ts.factory.createPropertyAccessExpression(ts.factory.createThis(), node.expression.text),
          node.name
        );
      }

      // `props.foo` 在组件实例模型里等价于 `this.foo`。
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        bindings.propAlias &&
        node.expression.text === bindings.propAlias &&
        bindings.propNames.has(node.name.text)
      ) {
        return ts.factory.createPropertyAccessExpression(
          ts.factory.createThis(),
          node.name.text
        );
      }

      if (
        ts.isIdentifier(node) &&
        hasPropAlias(bindings, node.text) &&
        !isShadowedByLocalScope(node.text) &&
        !isDeclarationIdentifier(node) &&
        !isPropertyNameIdentifier(node)
      ) {
        return readPropReplacement(bindings, node.text);
      }

      // `{ title }` 简写需要展开成 `{ title: this.title }`，否则 key 位置不会被改写。
      if (
        ts.isShorthandPropertyAssignment(node) &&
        hasPropAlias(bindings, node.name.text) &&
        !isShadowedByLocalScope(node.name.text)
      ) {
        return ts.factory.createPropertyAssignment(
          node.name,
          readPropReplacement(bindings, node.name.text)
        );
      }

      // 整体引用 props（如 `bindProps(props)`、`createExpose(props, ...)`）时，
      // 实例模型里没有原始形参，改用构造期由宿主注入的 `this.props` 快照。
      if (
        ts.isIdentifier(node) &&
        bindings.propAlias &&
        node.text === bindings.propAlias &&
        !isShadowedByLocalScope(node.text) &&
        !isDeclarationIdentifier(node) &&
        !isPropertyNameIdentifier(node)
      ) {
        return ts.factory.createPropertyAccessExpression(
          ts.factory.createThis(),
          'props'
        );
      }

      // 其余本地绑定在引用位置都提升为实例字段访问。
      if (
        ts.isIdentifier(node) &&
        (bindings.signalNames.has(node.text) ||
          bindings.computedNames.has(node.text)) &&
        !isShadowedByLocalScope(node.text) &&
        !isDeclarationIdentifier(node) &&
        !isPropertyNameIdentifier(node) &&
        !isAlreadyThisMember(node)
      ) {
        return ts.factory.createPropertyAccessExpression(ts.factory.createThis(), node.text);
      }

      if (
        ts.isIdentifier(node) &&
        bindings.localBindingNames.has(node.text) &&
        !isShadowedByLocalScope(node.text) &&
        !isDeclarationIdentifier(node) &&
        !isPropertyNameIdentifier(node) &&
        !isAlreadyThisMember(node)
      ) {
        // 普通 setup 绑定与 signal 最终都暴露成实例字段，读路径保持一致即可。
        return ts.factory.createPropertyAccessExpression(ts.factory.createThis(), node.text);
      }

      // 其余节点保持递归访问，让子表达式继续有机会命中特殊重写规则。
      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };
};

/** 在独立表达式包装中执行重写，并还原为表达式文本。 */
export const rewriteExpressionWithBindings = (
  expression: string,
  bindings: FunctionBindingContext
): string => {
  // 先包成一个最小合法语句，再借助 TS parser/transformer 只重写表达式内部引用。
  const wrapped = parseTypeScriptSource(
    '__lania_function_expression__.tsx',
    `const __lania_expr__ = (${expression});`
  );
  const statement = wrapped.statements[0];

  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return expression;
  }

  const initializer = statement.declarationList.declarations[0]?.initializer;

  if (!initializer) {
    return expression;
  }

  const transformed = ts.transform(wrapped, [createBindingTransformer(bindings)]);
  const nextSourceFile = transformed.transformed[0];
  const nextStatement = nextSourceFile.statements[0] as ts.VariableStatement;
  const nextInitializer = nextStatement.declarationList.declarations[0]?.initializer;
  transformed.dispose();

  if (!nextInitializer) {
    return expression;
  }

  if (ts.isParenthesizedExpression(nextInitializer)) {
    // 包装层额外引入的括号不应泄漏到最终表达式文本。
    return printer.printNode(
      ts.EmitHint.Expression,
      nextInitializer.expression,
      nextSourceFile
    );
  }

  return printer.printNode(ts.EmitHint.Expression, nextInitializer, nextSourceFile);
};

/** 在函数包装中重写语句块，保留原始语句顺序。 */
export const rewriteBlockWithBindings = (
  body: string,
  bindings: FunctionBindingContext
): string => {
  // 语句块重写走独立函数包装，方便同时保留原始语句顺序和块级语法合法性。
  const wrapped = parseTypeScriptSource(
    '__lania_function_block__.tsx',
    `function __lania_block__() {\n${body}\n}`
  );
  const transformed = ts.transform(wrapped, [createBindingTransformer(bindings)]);
  const nextSourceFile = transformed.transformed[0];
  const statement = nextSourceFile.statements[0];
  transformed.dispose();

  if (!statement || !ts.isFunctionDeclaration(statement) || !statement.body) {
    return body;
  }

  return statement.body.statements
    .map((childStatement) =>
      printer.printNode(ts.EmitHint.Unspecified, childStatement, nextSourceFile)
    )
    .join('\n');
};

// 模板树里的动态片段和 setup 代码共享同一套绑定重写规则，这里递归把表达式全部改写到位。
/** 递归重写模板节点中的动态表达式。 */
export const rewriteFunctionTemplateNode = (
  node: TemplateNode,
  bindings: FunctionBindingContext
): TemplateNode => {
  const rewriteChildren = (children: typeof node.children): typeof node.children => {
    return children.map((child) => {
      if (child.type === 'ExpressionNode') {
        return {
          ...child,
          expression: rewriteExpressionWithBindings(child.expression, bindings),
        };
      }

      if (child.type === 'ElementNode') {
        // 组件标签名不经表达式重写，但本地组件绑定（如 `const LazyHello = lazy(...)`）
        // 已被提升为实例字段，这里需要同步改写，否则生成代码会引用未定义标识符。
        const tagName =
          /^[A-Z][A-Za-z0-9_$]*$/.test(child.tagName) &&
          bindings.localBindingNames.has(child.tagName)
            ? `this.${child.tagName}`
            : child.tagName;

        // 模板树里的动态属性、事件、指令最终都复用同一套表达式重写口径。
        return {
          ...child,
          tagName,
          attributes: child.attributes.map((attribute) => ({
            ...attribute,
            value:
              attribute.static || attribute.value === null || typeof attribute.value === 'string'
                ? attribute.value
                : {
                    ...attribute.value,
                    expression: rewriteExpressionWithBindings(
                      attribute.value.expression,
                      bindings
                    ),
                  },
          })),
          events: child.events.map((event) => ({
            ...event,
            expression: rewriteExpressionWithBindings(event.expression, bindings),
          })),
          directives: child.directives.map((directive) => ({
            ...directive,
            expression: rewriteExpressionWithBindings(directive.expression, bindings),
          })),
          spreadAttributes: child.spreadAttributes?.map((expression) =>
            rewriteExpressionWithBindings(expression, bindings)
          ),
          children: rewriteChildren(child.children),
        };
      }

      return child;
    });
  };

  return {
    ...node,
    children: rewriteChildren(node.children),
  };
};
