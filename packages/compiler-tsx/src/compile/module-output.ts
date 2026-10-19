/**
 * TSX 编译模块输出组装器。
 *
 * 该文件位于“编译产物”与“集成层模块系统”之间，职责是：
 * 1. 保留用户源码里与业务有关的 import；
 * 2. 过滤并统一注入框架运行时依赖；
 * 3. 把组件类代码包装成可直接执行的 ES 模块；
 * 4. 生成指向编译后模块文本的 source map。
 *
 * 也就是说，这里不关心组件“怎么编译”，只关心“编译好的结果如何落成模块”：
 * - 用户 import 与框架 runtime import 分开处理，避免重复注入；
 * - 代码生成阶段留下的格式化小瑕疵会在这里做轻量收口；
 * - 最终输出既要能执行，也要尽量保留调试友好的 source map。
 */
import MagicString from 'magic-string';
import ts from 'typescript';

import type { CompiledTsxFunctionComponent } from './function-component';

export interface CompiledTsxFunctionComponentModule extends CompiledTsxFunctionComponent {
  // preambleCode 只保留用户业务 import，和运行时前导分层输出。
  preambleCode: string;
  moduleCode: string;
}

export interface CompiledTsxModule {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  compiled: CompiledTsxFunctionComponentModule;
}

const RUNTIME_IMPORT_PATTERN = /^['"]@lania-v\/runtime(?:\/[^'"]+)?['"]$/;

// 运行时能力按“组件基类/响应式 API/模板 slot/SSR 辅助”混合列举，
// 目的是让生成代码始终可以从单一入口稳定解构，而不是按需拼出多条 import。
// 这里显式列出模板代码生成阶段可能引用的运行时能力，统一从模块前导中解构出来。
const TSX_RUNTIME_BINDINGS = [
  'ReactiveElement',
  'createSignal',
  'createMemo',
  'createComputedAccessor',
  'createEffect',
  'batch',
  'watch',
  'readonly',
  'untrack',
  'createDeferred',
  'createStore',
  'getStorePathSignal',
  'createResource',
  'lazy',
  'onMount',
  'onMounted',
  'onCleanup',
  'onUnmounted',
  'onUpdated',
  'useContext',
  'withContextHost',
  'useFormValidity',
  'createRef',
  'createContext',
  'provideContext',
  'getComponentCreationProps',
  'createComponentPropsSnapshot',
  'parsePropAttributeValue',
  'reflectPropAttribute',
  'validatePropValue',
  'resolvePropOptions',
  'resolveObservedAttributes',
  'resolvePropInitialValue',
  'reflectInitialProps',
  'applyPropAttributes',
  'ssrRenderIslandSlot',
  'registerDirective',
  'When',
  'Each',
  'Fragment',
  'Dynamic',
  'Teleport',
  'KeepAlive',
  'Transition',
  'TransitionGroup',
  'LazyLoad',
  'ErrorBoundary',
  'Suspense',
  'createStaticTemplate',
  'createSSRRenderContext',
  'attachSSRRenderContext',
  'applySSRChunk',
  'hasHydrationSlot',
  'mountStaticTemplate',
  'readHydrationSlotNodes',
  'readTeleportNodes',
  'resolveSlotAnchor',
  'resolveTemplateNode',
  'resolveMountedTemplateNode',
  'resolveTextSlotNode',
  'TextSlot',
  'AttrSlot',
  'PropSlot',
  'StyleSlot',
  'ClassSlot',
  'EventSlot',
  'DirectiveBindingSlot',
  'ModelBindingSlot',
  'UseDirectiveSlot',
  'RefSlot',
  'ForSlot',
  'IfSlot',
  'DynamicSlot',
  'TeleportSlot',
  'SimpleUpdater',
  'MultiSlotUpdater',
  'ConditionUpdater',
  'EffectUpdater',
  'css',
  'ssrEvaluate',
  'ssrEscapeHtml',
  'ssrRenderBlockSlot',
  'ssrRenderEnhancedBoundary',
  'ssrRenderTeleportContainer',
  'ssrRenderTeleportSlot',
  'ssrRenderTextSlot',
  'ssrRenderSuspenseBoundary',
  'ssrDrainSuspenseChunks',
  'ssrResolveValue',
  'ssrSerializeAttribute',
  'createModelEventHandler',
  'withEventModifiers',
] as const;

// 少量高级追踪 API 只在生成代码真正引用到时才会从 advanced 入口解构出来。
const TSX_ADVANCED_RUNTIME_BINDINGS = [
  'trackSignals',
  'linkTrackedSignals',
  'isTracking',
] as const;

// 这一小步属于生成结果收口，不改业务语义，只修正打印器对对象字面量箭头函数的包裹形式。
const normalizeModelObjectUpdaters = (code: string): string => {
  return code
    .split('\n')
    .map((line) => {
      // 生成器会把对象字面量放进块体箭头函数里，这里修正为显式返回对象。
      if (!line.includes('new SimpleUpdater(() => { target:')) {
        return line;
      }

      return line
        .replace('(() => { target:', '(() => ({ target:')
        .replace(' }, slot', ' }), slot');
    })
    .join('\n');
};

const createRuntimeBindingBlock = (
  importName: string,
  moduleName: string,
  bindings: readonly string[]
): string => {
  // 统一先整体导入，再做解构，便于运行时导出表扩展时保持生成格式稳定。
  // 同时也让最终模块始终只产生一条 runtime import，减少重复 specifier。
  return [
    `import * as ${importName} from '${moduleName}';`,
    `const {`,
    ...bindings.map((binding) => `  ${binding},`),
    `} = ${importName};`,
  ].join('\n');
};

// 用户源码里的 runtime 具名导入会被前导过滤掉，因此需要收集回来统一注入，
// 否则 `bindProps` / `bindHandlers` 这类业务侧 API 会在运行时报未定义。
const collectUserRuntimeBindings = (
  fileName: string,
  source: string
): { root: string[]; advanced: string[] } => {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  );
  const root: string[] = [];
  const advanced: string[] = [];

  sourceFile.statements.forEach((stmt) => {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !stmt.importClause) {
      return;
    }

    const specifier = stmt.moduleSpecifier.getText(sourceFile);
    if (!RUNTIME_IMPORT_PATTERN.test(specifier)) {
      return;
    }

    const clause = stmt.importClause;
    const namedBindings = clause.namedBindings;
    if (clause.isTypeOnly || !namedBindings || !ts.isNamedImports(namedBindings)) {
      return;
    }

    const moduleName = specifier.slice(1, -1);
    // advanced 入口不在 runtime 根导出里，必须各自走对应模块。
    const target = moduleName === '@lania-v/runtime/advanced' ? advanced : root;
    namedBindings.elements.forEach((element) => {
      if (element.isTypeOnly) {
        return;
      }
      target.push(element.name.text);
    });
  });

  return { root, advanced };
};

const mergeBindingNames = (
  base: readonly string[],
  extras: readonly string[]
): string[] => {
  const merged = [...base];
  const seen = new Set(merged);

  extras.forEach((name) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    merged.push(name);
  });

  return merged;
};

// 最终模块文本由运行时前导、编译后的类代码以及默认/具名导出三部分组成。
const createLaniaTsxModuleCode = (
  className: string,
  classCode: string,
  classNames: readonly string[],
  runtimeBindings: readonly string[] = TSX_RUNTIME_BINDINGS,
  advancedBindings: readonly string[] = TSX_ADVANCED_RUNTIME_BINDINGS
): string => {
  const exportedNames = classNames.length > 0 ? classNames : [className];

  return [
    createRuntimeBindingBlock('__lania', '@lania-v/runtime', runtimeBindings),
    createRuntimeBindingBlock(
      '__laniaAdvanced',
      '@lania-v/runtime/advanced',
      advancedBindings
    ),
    '',
    classCode,
    '',
    `export default ${className};`,
    `export { ${exportedNames.join(', ')} };`,
  ].join('\n');
};

const collectBindingNames = (name: ts.BindingName, names: string[]): void => {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }

  name.elements.forEach((element) => {
    if (ts.isOmittedExpression(element)) {
      return;
    }

    collectBindingNames(element.name, names);
  });
};

const collectDeclaredNames = (statement: ts.Statement): string[] => {
  const names: string[] = [];

  if (ts.isVariableStatement(statement)) {
    statement.declarationList.declarations.forEach((declaration) => {
      collectBindingNames(declaration.name, names);
    });
    return names;
  }

  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    names.push(statement.name.text);
  }

  return names;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const referencesName = (text: string, name: string): boolean =>
  new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);

/**
 * 保留被编译产物引用到的模块级声明。
 *
 * 组件函数体已经被搬到类里，源码中的模块级常量/辅助函数不会自动进入输出。
 * 这里只在生成类代码确实引用到它们时才保留，既避免把整份源码搬进产物，
 * 也不会再出现“引用还在、声明被删”的运行时 ReferenceError。
 *
 * 同时保留 `Component.styles = ...` 这类针对组件类本身的静态配置语句，
 * 让样式、renderMode 等声明可以留在 `.lania.tsx` 内。
 */
const extractPreservedModuleStatements = (
  fileName: string,
  source: string,
  classNames: readonly string[],
  classCode: string
): { before: string; after: string } => {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  );
  const isComponentClass = (name: string): boolean => classNames.includes(name);
  const candidates: Array<{
    text: string;
    names: string[];
    forceInclude: boolean;
  }> = [];

  sourceFile.statements.forEach((statement) => {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportAssignment(statement)
    ) {
      return;
    }

    const names = collectDeclaredNames(statement);

    // 组件声明本身由编译产物替换，不能再原样保留。
    if (names.some(isComponentClass)) {
      return;
    }

    const text = statement.getText(sourceFile);
    const isComponentStaticAssignment =
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(statement.expression.left) &&
      ts.isIdentifier(statement.expression.left.expression) &&
      isComponentClass(statement.expression.left.expression.text);

    if (names.length === 0 && !isComponentStaticAssignment) {
      // 纯副作用语句不参与“被引用才保留”的推导。
      return;
    }

    candidates.push({ text, names, forceInclude: isComponentStaticAssignment });
  });

  const referenced = new Set<string>();
  const include = new Set<number>();

  candidates.forEach((candidate, index) => {
    if (candidate.forceInclude) {
      include.add(index);
    }

    candidate.names.forEach((name) => {
      if (referencesName(classCode, name)) {
        referenced.add(name);
        include.add(index);
      }
    });
  });

  // 辅助声明之间可能互相引用，迭代到不再新增为止。
  let changed = true;
  while (changed) {
    changed = false;

    candidates.forEach((candidate, index) => {
      if (!include.has(index)) {
        return;
      }

      candidate.names.forEach((name) => referenced.add(name));

      candidates.forEach((other, otherIndex) => {
        if (include.has(otherIndex)) {
          return;
        }

        if (other.names.some((name) => referencesName(candidate.text, name))) {
          include.add(otherIndex);
          changed = true;
        }
      });
    });
  }

  const before: string[] = [];
  const after: string[] = [];

  candidates.forEach((candidate, index) => {
    if (!include.has(index)) {
      return;
    }

    // 引用组件类本身的声明必须排到 class 定义之后，避免类声明 TDZ。
    const mustFollowClass =
      candidate.forceInclude ||
      candidate.names.some(isComponentClass) ||
      classNames.some((className) => referencesName(candidate.text, className));
    (mustFollowClass ? after : before).push(candidate.text);
  });

  return {
    before: before.join('\n'),
    after: after.join('\n'),
  };
};

const extractNonRuntimeImports = (fileName: string, source: string): string => {
  // 模块输出阶段重新扫描原始源码，只保留业务 import，不复用上游解析状态。
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  );

  const imports: string[] = [];
  sourceFile.statements.forEach((stmt) => {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier) {
      return;
    }
    const specifier = stmt.moduleSpecifier.getText(sourceFile);
    // 运行时依赖由编译器统一注入，避免与用户源码中的导入重复。
    if (RUNTIME_IMPORT_PATTERN.test(specifier)) {
      return;
    }
    imports.push(stmt.getText(sourceFile));
  });

  return imports.join('\n');
};

export const emitFunctionComponentTsxModule = (
  fileName: string,
  source: string,
  compiled: CompiledTsxFunctionComponent
): CompiledTsxFunctionComponentModule => {
  // 先保留用户原始 import，再拼接运行时代码与编译后的组件类定义。
  // 这样集成层既能继续解析用户依赖，也不会漏掉编译器自动注入的 runtime 能力。
  const preambleCode = extractNonRuntimeImports(fileName, source);
  const userRuntimeBindings = collectUserRuntimeBindings(fileName, source);
  const classCode = normalizeModelObjectUpdaters(
    compiled.componentClasses
      .map((entry) => entry.classCode.code)
      .join('\n\n')
  );
  const preservedCode = extractPreservedModuleStatements(
    fileName,
    source,
    compiled.classNames,
    classCode
  );
  const moduleCode = [
    preambleCode,
    preservedCode.before,
    createLaniaTsxModuleCode(
      compiled.className,
      classCode,
      compiled.classNames,
      mergeBindingNames(TSX_RUNTIME_BINDINGS, userRuntimeBindings.root),
      mergeBindingNames(TSX_ADVANCED_RUNTIME_BINDINGS, userRuntimeBindings.advanced)
    ),
    preservedCode.after,
  ]
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n\n');

  return {
    ...compiled,
    preambleCode,
    moduleCode,
  };
};

export const createCompiledTsxModuleMap = (
  fileName: string,
  source: string,
  moduleCode: string
): ReturnType<MagicString['generateMap']> => {
  const magicString = new MagicString(source.length > 0 ? source : '\n');

  // sourcemap 以“整份输入被编译产物替换”为假设，适合当前这种包裹层远多于局部替换的输出。
  // 直接用整段输出覆盖原文，生成面向编译后模块的高精度 sourcemap。
  // 这里不尝试逐段映射，是因为模块外壳和运行时前导几乎都是新增内容。
  magicString.overwrite(0, source.length > 0 ? source.length : 1, moduleCode);

  return magicString.generateMap({
    source: fileName,
    includeContent: true,
    hires: true,
  });
};
