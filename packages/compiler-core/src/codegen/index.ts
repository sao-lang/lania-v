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
  return initializer && initializer.trim().length > 0
    ? initializer
    : 'undefined';
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

const createFormAssociatedField = (component: ComponentIR): string => {
  // 浏览器在 upgrade 时读取该静态标记；必须在 customElements.define 之前就位。
  return component.formAssociated ? 'static formAssociated = true;' : '';
};

interface OrderedClassMember {
  order: number;
  code: string;
}

interface ClassMemberEmitOptions {
  /** dev 产物：字段初始化移入可重跑的 `__laniaSetup()`。 */
  hotReload?: boolean;
}

const createFieldDeclaration = (
  name: string,
  visibility: 'private' | 'protected',
  initializer: string,
  options: ClassMemberEmitOptions
): { declaration: string; setup: string } => {
  if (options.hotReload) {
    return {
      declaration: `${visibility} ${name}: any;`,
      setup: `this.${name} = ${initializer};`,
    };
  }

  return {
    declaration: `${visibility} ${name} = ${initializer};`,
    setup: '',
  };
};

// signal 与 setup field 最终都落成实例字段，初始化顺序必须还原组件体内的声明顺序：
// `const seed = read(); const count = createSignal(seed);` 一旦按类别分区输出，
// 就会在 seed 赋值前读取它，直接抛 TypeError。
const createFieldMembers = (
  component: ComponentIR,
  options: ClassMemberEmitOptions = {}
): { declarations: string[]; setup: string[] } => {
  const members: Array<OrderedClassMember & { setup: string }> = [
    ...component.signals.map((signal) => {
      const emitted = createFieldDeclaration(
        signal.name,
        'protected',
        stringifyInitializer(signal.initializer),
        options
      );

      return {
        order: signal.order ?? 0,
        code: emitted.declaration,
        setup: emitted.setup,
      };
    }),
    ...component.setupBindings
      .filter((binding) => binding.kind === 'field')
      .map((binding) => {
        const emitted = createFieldDeclaration(
          binding.name,
          'protected',
          stringifyInitializer(binding.initializer),
          options
        );

        return {
          order: binding.order ?? 0,
          code: emitted.declaration,
          setup: emitted.setup,
        };
      }),
  ];

  // sort 本身稳定：没有 order 信息时（例如类组件）维持原有的 signals -> setup 顺序。
  members.sort((left, right) => left.order - right.order);

  return {
    declarations: members.map((member) => member.code),
    setup: members
      .map((member) => member.setup)
      .filter((line) => line.length > 0),
  };
};

const createComputedFields = (
  component: ComponentIR,
  options: ClassMemberEmitOptions = {}
): { declarations: string[]; setup: string[] } => {
  const declarations: string[] = [];
  const setup: string[] = [];

  component.computed.forEach((computed) => {
    // computed 与 signal 共用同一实例语义：字段上是一个可调用句柄。
    // 读取写 `this.x()`，裸引用则拿到该句柄本身。
    // 这里用惰性求值而非 memo：模板 updater 依赖由编译期静态注入，
    // 不需要额外调度，也就不会出现 memo 与 DOM updater 的先后顺序问题。
    const expression = computed.expression?.trim().length
      ? computed.expression
      : 'undefined';
    const emitted = createFieldDeclaration(
      computed.name,
      'protected',
      `createComputedAccessor(() => ${expression})`,
      options
    );

    declarations.push(emitted.declaration);

    if (emitted.setup.length > 0) {
      setup.push(emitted.setup);
    }
  });

  return { declarations, setup };
};

// 字段型 setup 绑定已经并入 createFieldMembers，这里只处理方法与独立语句。
const createSetupBindingMembers = (component: ComponentIR): string[] => {
  return component.setupBindings
    .filter((binding) => binding.kind !== 'field')
    .map((binding) => {
      if (binding.kind === 'statement') {
        // statement 绑定真正执行发生在 connected/disconnected 中，这里只预留清理句柄。
        return `private ${binding.name}: (() => void) | undefined = undefined;`;
      }

      const signature = binding.params.trim();
      const body = binding.body?.trim().length ? binding.body : 'return;';

      return [
        signature.length > 0
          ? `protected ${binding.name}(${signature}): unknown {`
          : `protected ${binding.name}(): unknown {`,
        indent(body),
        `}`,
      ].join('\n');
    });
};

const getStatementSetupBindings = (component: ComponentIR) => {
  // statement 型 setup 语义接近“执行一段副作用并可返回清理函数”。
  return component.setupBindings.filter(
    (binding) => binding.kind === 'statement'
  );
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

const createPropOptionExpression = (
  component: ComponentIR,
  propName: string
): string =>
  `(this.constructor as typeof ${component.name}).propOptions?.[${JSON.stringify(
    propName
  )}]`;

const createPropFields = (
  component: ComponentIR,
  options: ClassMemberEmitOptions = {}
): { declarations: string[]; setup: string[] } => {
  const declarations: string[] = [];
  const setup: string[] = [];

  component.props.forEach((prop) => {
    const backingField = `__prop_${prop.name}`;
    const optionExpression = createPropOptionExpression(component, prop.name);
    const emitted = createFieldDeclaration(
      backingField,
      'private',
      `createSignal(resolvePropInitialValue(this, ${JSON.stringify(
        prop.name
      )}, ${stringifyInitializer(prop.initializer)}))`,
      options
    );

    declarations.push(emitted.declaration);

    if (emitted.setup.length > 0) {
      setup.push(emitted.setup);
    }

    declarations.push(
      // prop 在运行时用 signal 包一层，便于与普通 state 共享依赖跟踪逻辑。
      `get ${prop.name}(): unknown {`,
      indent(`return this.${backingField}.value;`),
      `}`,
      `set ${prop.name}(value: unknown) {`,
      indent(
        [
          // 统一通过 signal 更新，保证 prop 变更也能进入既有调度与依赖链路。
          `const previous = this.${backingField}.peek();`,
          // 事件回调等 prop 本身可能就是函数，不能走会被当成 updater 的 `set`。
          `this.${backingField}.setValue(value);`,
          // `bindProps()` / `bindHandlers()` 持有的是 props 快照，需要同步写入才能读到最新值。
          `if (this.props) this.props[${JSON.stringify(prop.name)}] = value;`,
          `const __option = ${optionExpression};`,
          `validatePropValue(${JSON.stringify(component.name)}, ${JSON.stringify(
            prop.name
          )}, value, __option);`,
          `reflectPropAttribute(this, ${JSON.stringify(prop.name)}, value, __option);`,
          `this.requestUpdate(${JSON.stringify(prop.name)}, previous, value);`,
        ].join('\n')
      ),
      `}`
    );
  });

  return { declarations, setup };
};

/**
 * `defineComponent(fn, options)` 生成的静态字段。
 *
 * 选项原文在运行时求值：`propOptions` / `emits` / `observedAttributes` 全部由
 * 选项对象推导，因此选项里可以写任意表达式，也不需要在编译期把它拆成字面量。
 */
const createComponentOptionsFields = (
  component: ComponentIR
): string | null => {
  const propNames = component.props.map((prop) => prop.name);
  const fields: string[] = [];

  if (component.optionsSource) {
    // 选项原文求值：propOptions / emits 都从这里来，选项里可以写任意表达式。
    fields.push(`static __laniaOptions = ${component.optionsSource};`);
    fields.push(
      `static propOptions = resolvePropOptions(this.__laniaOptions?.props);`
    );
    fields.push(`static emits = this.__laniaOptions?.emits;`);
  }

  if (propNames.length > 0) {
    // prop 名单来自类型，是编译期已知的；attribute 命名规则与 `attribute: false`
    // 则交给运行时按 propOptions 决定，因此表达式形式的配置同样生效。
    fields.push(`static __laniaPropNames = ${JSON.stringify(propNames)};`);
    fields.push(
      `static observedAttributes = resolveObservedAttributes(this.propOptions, this.__laniaPropNames);`
    );
  }

  return fields.length > 0 ? fields.join('\n') : null;
};

const createHandlerKeysField = (component: ComponentIR): string | null => {
  const handlerKeys = component.props
    .map((prop) => prop.name)
    .filter((name) => /^on[A-Z]/.test(name));

  if (handlerKeys.length === 0) {
    return null;
  }

  // 编译期已知的事件型 prop 名单，运行时可据此把 key 归入 handlers 视图，
  // 即使当前 handler 值为空也不会误判成普通 prop。
  return `static handlerKeys = ${JSON.stringify(handlerKeys)};`;
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
    return updater.expression.trim().length > 0
      ? updater.expression
      : 'return;';
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

const FUNCTION_LIFECYCLE_METHODS: Record<
  string,
  { method: string; signature: string }
> = {
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
  const bodies = callbackBodies
    .map((body) => body.trim())
    .filter((body) => body.length > 0);
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
        // attribute 名到 prop 的映射、类型转换与 converter 全部由运行时按
        // `static propOptions` / `static __laniaPropNames` 解析。
        'applyPropAttributes(this, name, newValue);',
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
  const groupedCallbacks = new Map<
    string,
    { params: string; bodies: string[] }
  >();
  const orderedHooks: string[] = [];
  // 这里先按 hook 分组，再按首次出现顺序回放，避免多来源生命周期输出顺序抖动。
  const ensureHookGroup = (
    hook: string,
    params = ''
  ): { params: string; bodies: string[] } => {
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

    if (
      !callbacks.some((callback) => callback.hook === 'disconnectedCallback')
    ) {
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
    const bodyLines = createClassLifecycleMethodBody(
      component,
      hook,
      callback.bodies
    );
    // 同名 hook 的多个来源会先合并，再统一生成一个稳定的方法实现。

    return [methodHeader, indent(bodyLines.join('\n')), `}`].join('\n');
  });
};

const createFunctionLifecycleMethods = (component: ComponentIR): string[] => {
  const groupedCallbacks = new Map<
    string,
    { params: string; bodies: string[] }
  >();
  const orderedHooks: string[] = [];
  // 函数式生命周期会被改写成一组内部专用方法，生成策略与类生命周期分开处理。
  const ensureHookGroup = (
    hook: string,
    params = ''
  ): { params: string; bodies: string[] } => {
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
    const signature =
      callback.params.trim().length > 0
        ? callback.params.trim()
        : meta.signature;
    const methodHeader =
      signature.length > 0
        ? `protected ${meta.method}(${signature}): void {`
        : `protected ${meta.method}(): void {`;
    const body =
      callback.bodies.length > 0 ? callback.bodies.join('\n') : 'return;';

    return [methodHeader, indent(body), `}`].join('\n');
  });
};

export const generateClassComponentCode = (
  component: ComponentIR,
  options: ClassMemberEmitOptions = {}
): ClassComponentCodegenResult => {
  // render plan 上的信息在这里被一次性摊平，分别喂给 CSR 与 SSR 生成器。
  const renderCode = generateRenderCode({
    className: component.name,
    staticHtml: component.renderPlan.staticHtml,
    textBindings: component.renderPlan.textBindings,
    componentBindings: component.renderPlan.componentBindings,
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
  const handlerKeysField = createHandlerKeysField(component);
  const propFields = createPropFields(component, options);
  const fieldMembers = createFieldMembers(component, options);
  const computedFields = createComputedFields(component, options);
  const setupLines = [
    ...propFields.setup,
    ...fieldMembers.setup,
    ...computedFields.setup,
  ];
  // dev 产物把 setup 收进可重跑的方法，HMR 换实现时可以按字段名重建状态。
  const setupMethod =
    options.hotReload && setupLines.length > 0
      ? [
          'protected __laniaSetup(): void {',
          indent(setupLines.join('\n')),
          '}',
          'constructor() {',
          indent(['super();', 'this.__laniaSetup();'].join('\n')),
          '}',
        ].join('\n')
      : '';
  // 类体按“声明成员 -> SSR -> CSR -> 生命周期 -> updater”顺序拼接，便于阅读。
  // 这个顺序也让静态字段、prop 桥接、渲染方法和调试用 updater 在生成结果中分区更稳定。
  const bodySections = [
    createComponentOptionsFields(component) ?? '',
    handlerKeysField ?? '',
    createTagNameField(component),
    createDisplayNameField(component),
    createFormAssociatedField(component),
    ...propFields.declarations,
    ...fieldMembers.declarations,
    ...computedFields.declarations,
    ...createSetupBindingMembers(component),
    setupMethod,
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
