import type { ComponentIR } from '../ir/component';
import { generateRenderCode, type RenderCodegenResult } from './render';
import { generateSSRCode, type SSRCodegenResult } from './ssr';

/**
 * 类组件代码生成入口。
 *
 * 这个模块不直接负责“如何生成某一类片段”，而是负责把多个子结果
 * 组装成一份完整组件类源码：
 * - render codegen 负责 CSR 渲染与运行时挂载逻辑；
 * - SSR codegen 负责同步字符串渲染与流式渲染；
 * - 当前模块则补齐字段、生命周期、updater 方法以及最终类体拼装顺序。
 *
 * 因此这里更像一个“源码装配器”，输入是结构化 `ComponentIR`，
 * 输出则是方便落盘或继续加工的完整代码片段集合。
 *
 * 这里有两个重要约束：
 * 1. 尽量保持生成结果顺序稳定，方便测试快照和人工排查；
 * 2. 即便上游 IR 某些字段缺失，也尽量生成一个语义保守但结构完整的类体。
 *
 * 因而这里的实现重点不是复杂算法，而是“稳定装配”：
 * - 不同成员按固定顺序输出，降低代码生成 diff 抖动；
 * - 对空表达式、缺失生命周期和 setup 退化分支统一兜底；
 * - 让 CSR / SSR / 生命周期三条链路最终汇合成一份可读类定义。
 *
 * 另外，它还承担两层“桥接”职责：
 * - 把 props / observedAttributes / attributeChangedCallback 串成一条属性同步链；
 * - 把多来源生命周期与 setup statement 清理逻辑汇总成稳定的方法输出顺序。
 */

export interface ClassComponentCodegenResult {
  className: string;
  renderCode: RenderCodegenResult;
  ssrCode: SSRCodegenResult;
  updaterMethods: string[];
  classBody: string;
  code: string;
}

const indent = (source: string, level = 1): string => {
  const prefix = '  '.repeat(level);

  return source
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
};

const stringifyInitializer = (initializer: string | null): string => {
  // 统一把“空初始化器”收敛成 `undefined`，避免生成不完整成员声明。
  return initializer && initializer.trim().length > 0 ? initializer : 'undefined';
};

const toKebabCase = (value: string): string => {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
};

const inferComponentTagName = (rawName: string): string => {
  const base = toKebabCase(rawName);
  // Custom Element 标签必须带连字符；如果原名不满足则补一个保底前缀。
  const withHyphen = base.includes('-') ? base : `x-${base || 'component'}`;
  return withHyphen.startsWith('xml') ? `x-${withHyphen}` : withHyphen;
};

const createTagNameField = (component: ComponentIR): string => {
  // 自定义元素标签名在编译期固定下来，运行时无需重复推断。
  return `static tagName = ${JSON.stringify(inferComponentTagName(component.name))};`;
};

const createDisplayNameField = (component: ComponentIR): string => {
  // `static name` is not safe/portable (Function.name is read-only); use `displayName` instead.
  return `static displayName = ${JSON.stringify(component.name)};`;
};

const createSignalFields = (component: ComponentIR): string[] => {
  return component.signals.map((signal) => {
    return `protected ${signal.name} = ${stringifyInitializer(signal.initializer)};`;
  });
};

const createComputedFields = (component: ComponentIR): string[] => {
  return component.computed.map((computed) => {
    // 缺失表达式时仍输出一个稳定 getter，避免生成代码缺口。
    const body = computed.expression?.trim().length
      ? `return ${computed.expression};`
      : 'return undefined;';

    return [
      `get ${computed.name}(): unknown {`,
      indent(body),
      `}`,
    ].join('\n');
  });
};

const createSetupBindingMembers = (component: ComponentIR): string[] => {
  return component.setupBindings.map((binding) => {
    if (binding.kind === 'method') {
      const signature = binding.params.trim();
      const body = binding.body?.trim().length ? binding.body : 'return;';

      return [
        signature.length > 0
          ? `protected ${binding.name}(${signature}): unknown {`
          : `protected ${binding.name}(): unknown {`,
        indent(body),
        `}`,
      ].join('\n');
    }

    if (binding.kind === 'statement') {
      // statement 绑定真正执行发生在 connected/disconnected 中，这里只预留清理句柄。
      return `private ${binding.name}: (() => void) | undefined = undefined;`;
    }

    return `protected ${binding.name} = ${stringifyInitializer(binding.initializer)};`;
  });
};

const getStatementSetupBindings = (component: ComponentIR) => {
  // statement 型 setup 语义接近“执行一段副作用并可返回清理函数”。
  return component.setupBindings.filter((binding) => binding.kind === 'statement');
};

const createSetupConnectedLines = (component: ComponentIR): string[] => {
  return getStatementSetupBindings(component).flatMap((binding) => {
    const resultVar = `${binding.name}Result`;
    const expression = stringifyInitializer(binding.initializer);

    return [
      // statement 型 setup 可能返回清理函数，这里在 connected 时先执行再缓存。
      `const ${resultVar} = ${expression};`,
      `this.${binding.name} = typeof ${resultVar} === 'function' ? ${resultVar} : undefined;`,
    ];
  });
};

const createSetupDisconnectedLines = (component: ComponentIR): string[] => {
  return getStatementSetupBindings(component).flatMap((binding) => {
    return [
      // disconnected 时统一调用并清空，避免重复挂载产生陈旧清理句柄。
      `this.${binding.name}?.();`,
      `this.${binding.name} = undefined;`,
    ];
  });
};

const createPropParserExpression = (prop: ComponentIR['props'][number]): string => {
  // attributeChangedCallback 收到的始终是字符串/null，这里统一回到声明类型。
  switch (prop.propertyType) {
    case 'Number':
      return "newValue === null ? undefined : Number(newValue)";
    case 'Boolean':
      return "newValue !== null && newValue !== 'false'";
    case 'Object':
      return 'newValue === null ? undefined : JSON.parse(newValue)';
    case 'String':
    default:
      return 'newValue ?? undefined';
  }
};

const createPropFields = (component: ComponentIR): string[] => {
  return component.props.flatMap((prop) => {
    const backingField = `__prop_${prop.name}`;

    return [
      // prop 在运行时用 signal 包一层，便于与普通 state 共享依赖跟踪逻辑。
      `private ${backingField} = createSignal(${stringifyInitializer(prop.initializer)});`,
      `get ${prop.name}(): unknown {`,
      indent(`return this.${backingField}();`),
      `}`,
      `set ${prop.name}(value: unknown) {`,
      indent(
        [
          // 统一通过 signal 更新，保证 prop 变更也能进入既有调度与依赖链路。
          `const previous = this.${backingField}.peek();`,
          `this.${backingField}.set(value);`,
          `this.requestUpdate(${JSON.stringify(prop.name)}, previous, value);`,
        ].join('\n')
      ),
      `}`,
    ];
  });
};

const createObservedAttributesField = (component: ComponentIR): string | null => {
  if (component.props.length === 0) {
    return null;
  }

  // 仅属性型 signal 需要映射到 Custom Element 的 observedAttributes。
  return `static observedAttributes = ${JSON.stringify(
    component.props.map((prop) => prop.name)
  )};`;
};

const createUpdaterMethodBody = (
  component: ComponentIR,
  updaterName: string
): string => {
  const updater = component.updaterGeneration.updaters.find(
    (candidate) => candidate.name === updaterName
  );

  if (!updater) {
    return 'return;';
  }

  if (updater.kind === 'effect') {
    // effect 已经是完整语句块，不需要额外包裹。
    return updater.expression.trim().length > 0 ? updater.expression : 'return;';
  }

  if (updater.expression.trim().length === 0) {
    return 'return;';
  }

  // 普通 updater 以表达式形式保存，这里显式包成语句，生成稳定的方法体。
  return `void (${updater.expression});`;
};

const createUpdaterMethods = (component: ComponentIR): string[] => {
  return component.updaterGeneration.updaters.map((updater) => {
    const body = createUpdaterMethodBody(component, updater.name);
    const comment = `// ${updater.kind} | deps: ${updater.dependencies.join(', ') || 'none'} | slots: ${updater.slotIndices.join(', ') || 'none'}`;

    return [
      `${comment}`,
      `protected ${updater.name}(): void {`,
      indent(body),
      `}`,
    ].join('\n');
  });
};

const CLASS_LIFECYCLE_DEFAULT_SIGNATURES: Record<string, string> = {
  connectedCallback: '',
  disconnectedCallback: '',
  adoptedCallback: '',
  attributeChangedCallback:
    'name: string, oldValue: string | null, newValue: string | null',
  errorCallback: 'error: unknown',
  willUpdate: 'changedProps: ChangedProps',
  updated: 'changedProps: ChangedProps',
};

const FUNCTION_LIFECYCLE_METHODS: Record<string, { method: string; signature: string }> = {
  onMount: {
    method: '__fcOnMount',
    signature: '',
  },
  onCleanup: {
    method: '__fcOnCleanup',
    signature: '',
  },
  onUpdated: {
    method: '__fcOnUpdated',
    signature: 'changedProps: ChangedProps',
  },
};

const createClassLifecycleMethodBody = (
  component: ComponentIR,
  hook: string,
  callbackBodies: readonly string[]
): string[] => {
  const bodies = callbackBodies.map((body) => body.trim()).filter((body) => body.length > 0);
  const setupConnectedLines = createSetupConnectedLines(component);
  const setupDisconnectedLines = createSetupDisconnectedLines(component);

  switch (hook) {
    case 'connectedCallback':
      // connected 阶段先跑父类，再执行 setup statement 和用户回调，保持挂载时序清晰。
      return ['super.connectedCallback();', ...setupConnectedLines, ...bodies];
    case 'disconnectedCallback':
      if (bodies.length === 0 && setupDisconnectedLines.length === 0) {
        return ['super.disconnectedCallback();'];
      }

      // 确保用户逻辑抛错时仍会执行父类清理。
      return [
        'try {',
        indent([...setupDisconnectedLines, ...bodies].join('\n')),
        '} finally {',
        indent('super.disconnectedCallback();'),
        '}',
      ];
    case 'adoptedCallback':
      return ['super.adoptedCallback();', ...bodies];
    case 'attributeChangedCallback':
      return [
        ...component.props.map((prop) => {
          return [
            `if (name === ${JSON.stringify(prop.name)}) {`,
            // 统一把 attribute 字符串值转换回声明的 prop 类型。
            indent(`this.${prop.name} = ${createPropParserExpression(prop)};`),
            `}`,
          ].join('\n');
        }),
        'super.attributeChangedCallback(name, oldValue, newValue);',
        ...bodies,
      ];
    case 'errorCallback':
      return ['super.errorCallback(error);', ...bodies];
    case 'willUpdate':
      return ['super.willUpdate(changedProps);', ...bodies];
    case 'updated':
      return ['super.updated(changedProps);', ...bodies];
    default:
      return bodies.length > 0 ? bodies : ['return;'];
  }
};

const createClassLifecycleMethods = (component: ComponentIR): string[] => {
  const callbacks = [...component.lifecycleCallbacks];
  const hasStatementBindings = component.setupBindings.some(
    (binding) => binding.kind === 'statement'
  );
  const groupedCallbacks = new Map<string, { params: string; bodies: string[] }>();
  const orderedHooks: string[] = [];
  // 这里先按 hook 分组，再按首次出现顺序回放，避免多来源生命周期输出顺序抖动。
  const ensureHookGroup = (hook: string, params = ''): { params: string; bodies: string[] } => {
    const existing = groupedCallbacks.get(hook);
    if (existing) {
      if (!existing.params && params.trim().length > 0) {
        existing.params = params.trim();
      }
      return existing;
    }

    const created = {
      params: params.trim(),
      bodies: [] as string[],
    };
    groupedCallbacks.set(hook, created);
    orderedHooks.push(hook);
    return created;
  };

  if (
    component.props.length > 0 &&
    !callbacks.some((callback) => callback.hook === 'attributeChangedCallback')
  ) {
    // 只要存在 prop，就补一个 attributeChangedCallback，保证 attribute -> prop 同步链成立。
    callbacks.push({
      hook: 'attributeChangedCallback',
      params: '',
      body: null,
    });
  }

  if (hasStatementBindings) {
    if (!callbacks.some((callback) => callback.hook === 'connectedCallback')) {
      // statement setup 需要在连接阶段执行，因此至少要生成 connected/disconnected 壳子。
      callbacks.push({
        hook: 'connectedCallback',
        params: '',
        body: null,
      });
    }

    if (!callbacks.some((callback) => callback.hook === 'disconnectedCallback')) {
      callbacks.push({
        hook: 'disconnectedCallback',
        params: '',
        body: null,
      });
    }
  }

  callbacks.forEach((callback) => {
    if (callback.hook in FUNCTION_LIFECYCLE_METHODS) {
      // 函数式生命周期会在另一套专用方法里收口，这里跳过类生命周期分组。
      return;
    }

    const group = ensureHookGroup(callback.hook, callback.params);
    if (callback.body?.trim()) {
      group.bodies.push(callback.body.trim());
    }
  });

  return orderedHooks.map((hook) => {
    const callback = groupedCallbacks.get(hook)!;
    const signature =
      callback.params.trim().length > 0
        ? callback.params.trim()
        : (CLASS_LIFECYCLE_DEFAULT_SIGNATURES[hook] ?? '');
    const methodHeader =
      signature.length > 0
        ? `${hook}(${signature}): void {`
        : `${hook}(): void {`;
    const bodyLines = createClassLifecycleMethodBody(component, hook, callback.bodies);
    // 同名 hook 的多个来源会先合并，再统一生成一个稳定的方法实现。

    return [methodHeader, indent(bodyLines.join('\n')), `}`].join('\n');
  });
};

const createFunctionLifecycleMethods = (component: ComponentIR): string[] => {
  const groupedCallbacks = new Map<string, { params: string; bodies: string[] }>();
  const orderedHooks: string[] = [];
  // 函数式生命周期会被改写成一组内部专用方法，生成策略与类生命周期分开处理。
  const ensureHookGroup = (hook: string, params = ''): { params: string; bodies: string[] } => {
    const existing = groupedCallbacks.get(hook);
    if (existing) {
      if (!existing.params && params.trim().length > 0) {
        existing.params = params.trim();
      }
      return existing;
    }

    const created = {
      params: params.trim(),
      bodies: [] as string[],
    };
    groupedCallbacks.set(hook, created);
    orderedHooks.push(hook);
    return created;
  };

  component.lifecycleCallbacks.forEach((callback) => {
    if (!(callback.hook in FUNCTION_LIFECYCLE_METHODS)) {
      // 非函数式 hook 仍按 Custom Element 生命周期输出，不混在这条分支里。
      return;
    }

    const group = ensureHookGroup(callback.hook, callback.params);
    if (callback.body?.trim()) {
      group.bodies.push(callback.body.trim());
    }
  });

  return orderedHooks.map((hook) => {
    const callback = groupedCallbacks.get(hook)!;
    const meta = FUNCTION_LIFECYCLE_METHODS[hook];
    const signature = callback.params.trim().length > 0 ? callback.params.trim() : meta.signature;
    const methodHeader =
      signature.length > 0
        ? `protected ${meta.method}(${signature}): void {`
        : `protected ${meta.method}(): void {`;
    const body = callback.bodies.length > 0 ? callback.bodies.join('\n') : 'return;';

    return [methodHeader, indent(body), `}`].join('\n');
  });
};

export const generateClassComponentCode = (
  component: ComponentIR
): ClassComponentCodegenResult => {
  // render plan 上的信息在这里被一次性摊平，分别喂给 CSR 与 SSR 生成器。
  const renderCode = generateRenderCode({
    className: component.name,
    staticHtml: component.renderPlan.staticHtml,
    textBindings: component.renderPlan.textBindings,
    listBindings: component.renderPlan.listBindings,
    conditionBindings: component.renderPlan.conditionBindings,
    dynamicBindings: component.renderPlan.dynamicBindings,
    boundaryBindings: component.renderPlan.boundaryBindings,
    transitionBindings: component.renderPlan.transitionBindings,
    keepAliveBindings: component.renderPlan.keepAliveBindings,
    teleportBindings: component.renderPlan.teleportBindings,
    allocatedSlots: component.slotAllocation.slots,
    runtimeUpdaters: component.renderPlan.runtimeUpdaters,
    signalBindingMap: component.renderPlan.signalBindingMap,
    storeBindingMap: component.renderPlan.storeBindingMap,
  });
  const ssrCode = generateSSRCode(component);
  const updaterMethods = createUpdaterMethods(component);
  const lifecycleMethods = [
    ...createClassLifecycleMethods(component),
    ...createFunctionLifecycleMethods(component),
  ];
  const observedAttributesField = createObservedAttributesField(component);
  // 类体按“声明成员 -> SSR -> CSR -> 生命周期 -> updater”顺序拼接，便于阅读。
  // 这个顺序也让静态字段、prop 桥接、渲染方法和调试用 updater 在生成结果中分区更稳定。
  const bodySections = [
    observedAttributesField ?? '',
    createTagNameField(component),
    createDisplayNameField(component),
    ...createPropFields(component),
    ...createSignalFields(component),
    ...createComputedFields(component),
    ...createSetupBindingMembers(component),
    ssrCode.method,
    ssrCode.streamMethod,
    renderCode.method,
    ...lifecycleMethods,
    ...updaterMethods,
  ].filter((section) => section.trim().length > 0);
  const classBody = [
    `class ${component.name} extends ReactiveElement {`,
    indent(bodySections.join('\n\n')),
    `}`,
  ].join('\n');
  // hoist 保持在类定义前，保证静态模板与辅助常量在方法体引用前已可见。
  const code = [...renderCode.hoists, '', classBody].join('\n');

  return {
    className: component.name,
    renderCode,
    ssrCode,
    updaterMethods,
    classBody,
    code,
  };
};

export * from './render';
export * from './ssr';
