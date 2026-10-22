# Prop 选项与事件声明

## 1. 用法

`.lania.tsx` 里可以在 `defineComponent` 的第二个参数声明 prop 的 attribute 行为与事件名单：

```tsx
type FancyInputProps = {
  count: number;
  userName: string;
  active: boolean;
  onSelect?: (value: number) => void;
};

export default defineComponent(
  function FancyInput(props: FancyInputProps) {
    return <div>{props.count}</div>;
  },
  {
    props: {
      count: { type: Number, reflect: true, default: 0 },
      userName: { type: String, attribute: 'user-name' },
      active: { type: Boolean, reflect: true },
      onSelect: { attribute: false },
    },
    emits: ['select'],
  }
);
```

## 2. 支持的选项

| 选项             | 类型                                 | 说明                                    |
| ---------------- | ------------------------------------ | --------------------------------------- |
| `type`           | `String/Number/Boolean/Object/Array` | attribute 字符串的回读类型              |
| `attribute`      | `string \| false`                    | 自定义 attribute 名；`false` 表示不同步 |
| `reflect`        | `boolean`                            | prop 变化时是否写回 attribute           |
| `default`        | 任意表达式                           | prop signal 的初始值                    |
| `converter.from` | `(value) => unknown`                 | 自定义 attribute -> prop 转换           |
| `converter.to`   | `(value) => string \| null`          | 自定义 prop -> attribute 转换           |
| `validator`      | `(value) => boolean`                 | dev 下校验失败输出 warning              |

`emits` 是字符串数组，参与 `emit()` 校验；未声明的事件在 dev 环境下输出 warning。

## 3. 默认 attribute 名

未显式设置 `attribute` 时，prop 名会按 kebab-case 映射：

- `userName` -> `user-name`
- `maxCount` -> `max-count`
- `title` -> `title`

`attribute: false` 的 prop 不会进入 `observedAttributes`，也不会被反射。

## 4. 运行时辅助 API

如果需要在手写运行时里复用同样的规则：

```ts
import {
  normalizePropOption,
  parsePropAttributeValue,
  reflectPropAttribute,
  resolvePropAttributeName,
  serializePropAttributeValue,
  validatePropValue,
} from '@lania-v/runtime';
```

## 5. 选项求值时机

选项对象会**原样**进入编译产物，并在类求值时执行：

```ts
class FancyInput extends ReactiveElement {
  static __laniaOptions = { props: sharedProps, emits: EVENTS };
  static propOptions = resolvePropOptions(this.__laniaOptions?.props);
  static emits = this.__laniaOptions?.emits;
  static observedAttributes = resolveObservedAttributes(
    this.propOptions,
    this.__laniaPropNames
  );
}
```

因此下面这些写法现在都成立（不再要求字面量）：

```tsx
import {
  ATTR_NAMES,
  SHARED_EVENTS,
  convertLevel,
  sharedProps,
} from './props-config';

export default defineComponent(
  function FancyInput(props: FancyInputProps) {
    return <div>{props.count}</div>;
  },
  {
    props: sharedProps, // 模块级常量 / 导入
    emits: SHARED_EVENTS, // 导入的数组
  }
);
```

- `attribute: ATTR_NAMES.count` 这类表达式会在类求值时参与 `observedAttributes` 推导；
- `converter` / `validator` 可以直接引用 `import` 进来的函数；
- `props: { ...sharedProps, extra: Number }` 也支持（展开由运行时完成）；
- 编译器仍会对**字面量**选项做廉价校验（未知 prop / 未知选项 / `emits` 非字符串）。

## 6. 当前边界

- 选项在模块求值期执行；依赖的值必须在该时点已初始化（与 Vue 的 SFC 行为一致）。
- `props` 字面量里的 key 必须在 props 类型里声明；未声明的 key 会直接编译报错。
- `type` 建议使用 `String / Number / Boolean / Object / Array`；其他构造函数会退化为字符串直传，
  需要结构化转换请用 `converter`。
- `props` / `emits` 必须是 `defineComponent` 的第二个参数，暂不支持组件外静态赋值。
