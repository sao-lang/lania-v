/**
 * 编译器前端 AST 定义。
 *
 * 这里描述装饰器/模板解析后的统一语法树，供后续 IR lowering、
 * 依赖分析、优化和代码生成阶段复用。
 */

/** 输入源码的来源类型。 */
export type CompilerSourceKind =
  'tsx-class-component' | 'tsx-function-component' | 'sfc';

/** 单个源码文件的顶层编译结果。 */
export interface CompilerProgram {
  type: 'Program';
  fileName: string;
  sourceKind: CompilerSourceKind;
  body: ComponentDeclaration[];
}

/** 组件声明节点。 */
export interface ComponentDeclaration {
  type: 'ComponentDeclaration';
  name: string;
  componentKind: 'class' | 'function';
  signals: SignalDeclaration[];
  computed: ComputedDeclaration[];
  effects: EffectDeclaration[];
  lifecycleHooks: string[];
  lifecycleCallbacks: LifecycleCallbackDeclaration[];
  setupBindings: SetupBindingDeclaration[];
  template: TemplateNode;
  /**
   * 组件是否参与原生表单提交。
   *
   * 由 `useFormValue(...)` 或类上的 `static formAssociated = true` 推导，
   * 代码生成阶段据此输出 `static formAssociated = true;`。
   */
  formAssociated?: boolean;
  /**
   * `defineComponent(fn, options)` 第二个参数的**原文**。
   *
   * 代码生成阶段把它原样搬进产物（`static __laniaOptions = ...`），
   * 由运行时在类求值时解析，因此选项里可以写任意表达式、引用 import。
   */
  optionsSource?: string;
}

/** 生命周期回调的源码片段。 */
export interface LifecycleCallbackDeclaration {
  type: 'LifecycleCallbackDeclaration';
  hook: string;
  params: string;
  body: string | null;
}

/** setup 阶段提升出的字段或方法。 */
export interface SetupBindingDeclaration {
  type: 'SetupBindingDeclaration';
  name: string;
  kind: 'field' | 'method' | 'statement';
  params: string;
  body: string | null;
  initializer: string | null;
  /**
   * 组件体内声明的源码顺序。
   *
   * signal 与 setup 字段在 IR 里被拆到不同数组，生成期若按数组分区输出，
   * `const seed = read(); const count = createSignal(seed);` 就会先读 `seed` 再赋值。
   * 记录该序号后，代码生成可以还原真实初始化顺序。
   */
  order?: number;
}

/** signal 声明。 */
export interface SignalDeclaration {
  type: 'SignalDeclaration';
  name: string;
  signalKind: 'state' | 'property' | 'unknown';
  initializer: string | null;
  propertyType?: 'String' | 'Number' | 'Boolean' | 'Object' | 'Array';
  /** 组件体内声明的源码顺序，含义同 `SetupBindingDeclaration.order`。 */
  order?: number;
}

/** computed 声明。 */
export interface ComputedDeclaration {
  type: 'ComputedDeclaration';
  name: string;
  expression: string | null;
}

/** effect 声明。 */
export interface EffectDeclaration {
  type: 'EffectDeclaration';
  name: string;
  body: string | null;
}

/** 模板根节点。 */
export interface TemplateNode {
  type: 'TemplateNode';
  children: TemplateChildNode[];
}

/** 元素节点。 */
export interface ElementNode {
  type: 'ElementNode';
  tagName: string;
  attributes: AttributeNode[];
  events: EventNode[];
  directives: DirectiveNode[];
  /**
   * `client:<priority>` 声明的 island 水合优先级。
   *
   * 只允许出现在组件标签上；该 attribute 不会作为 prop 传给子组件。
   */
  island?: { priority: string };
  /**
   * `{...rest}` 形式的组件 props 展开表达式。
   *
   * 目前只在组件标签上生效；原生标签上的 spread 会在模板解析阶段报错，
   * 避免出现“编译成功但属性被静默丢弃”的行为。
   */
  spreadAttributes?: string[];
  children: TemplateChildNode[];
  selfClosing: boolean;
}

/** 纯文本节点。 */
export interface TextNode {
  type: 'TextNode';
  value: string;
}

/** 动态表达式节点。 */
export interface ExpressionNode {
  type: 'ExpressionNode';
  expression: string;
}

/** 属性节点。 */
export interface AttributeNode {
  type: 'AttributeNode';
  name: string;
  value: string | ExpressionNode | null;
  static: boolean;
}

/** 事件绑定节点。 */
export interface EventListenerOptionsNode {
  once?: boolean;
  capture?: boolean;
  passive?: boolean;
}

export interface EventNode {
  type: 'EventNode';
  name: string;
  expression: string;
  modifiers: string[];
  listener?: EventListenerOptionsNode;
  /** 需要额外监听的提示性修饰符（`debounce` / `throttle`）。 */
  hints?: string[];
  component: boolean;
}

/** 指令节点。 */
export interface DirectiveNode {
  type: 'DirectiveNode';
  kind:
    | 'bind'
    | 'model'
    | 'html'
    | 'style'
    | 'use'
    | 'attr'
    | 'on'
    | 'ref'
    | 'unknown';
  name: string;
  expression: string;
  modifiers: string[];
  unit?: string;
}

/** 模板允许出现的子节点类型。 */
export type TemplateChildNode = ElementNode | TextNode | ExpressionNode;
