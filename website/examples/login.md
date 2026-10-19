# 示例：登录表单

这个示例来自 `playground/login/src/LoginPage.lania.tsx`，覆盖：

- 表单状态与校验；
- `createMemo` 派生；
- `createEffect`；
- `onMount`；
- `When`；
- `useFormValue` 表单关联；
- 组件样式与 Shadow DOM。

## 状态与校验

```tsx
import {
  createEffect,
  createMemo,
  createSignal,
  defineComponent,
  onMount,
  useFormValue,
  When,
} from '@lania-v/runtime';

type LoginStatus = 'idle' | 'submitting' | 'success';

export default defineComponent(function LoginPage() {
  const account = createSignal('');
  const password = createSignal('');
  const remember = createSignal(false);
  const passwordVisible = createSignal(false);
  const status = createSignal<LoginStatus>('idle');
  const accountTouched = createSignal(false);
  const passwordTouched = createSignal(false);

  const accountMissing = createMemo(() => account().trim().length === 0);
  const passwordMissing = createMemo(() => password().length === 0);
  const submitting = createMemo(() => status() === 'submitting');
  const canSubmit = createMemo(
    () => !accountMissing() && !passwordMissing() && !submitting()
  );
  const accountInvalid = createMemo(() => accountTouched() && accountMissing());
  const passwordInvalid = createMemo(
    () => passwordTouched() && passwordMissing()
  );

  useFormValue(() => account());

  createEffect(() => {
    console.log('account changed:', account());
  });

  onMount(() => {
    console.log('mounted');
  });

  // ...
});
```

### 为什么用 Memo

`accountMissing` 被多个位置读取：

- `canSubmit`；
- `accountInvalid`；
- 模板中的错误提示。

用 `createMemo` 可以避免重复计算，并让每个读取点只订阅需要的结果。

### `useFormValue`

```ts
useFormValue(() => account());
```

编译后：

- 组件类生成 `static formAssociated = true`；
- 生成一个 effect Updater，`account` 变化时调用 `_setFormValue(account())`。

因此：

```ts
const form = document.querySelector('form')!;
new FormData(form).get('account'); // 当前账号
```

只有宿主元素有 `name` 属性时，`FormData` 才会带上它：

```html
<x-login-page name="login"></x-login-page>
```

## 提交

```tsx
const onSubmit = () => {
  accountTouched.set(true);
  passwordTouched.set(true);

  if (!canSubmit()) return;

  status.set('submitting');

  setTimeout(() => {
    status.set('success');
  }, 700);
};
```

`canSubmit()` 读取三个 Memo，因此按钮的 `disabled` 会精确更新。

## 模板

```tsx
return (
  <section className="card">
    <h1>欢迎回来</h1>

    <label className="field">
      <span>账号</span>
      <input
        className={accountInvalid() ? 'input is-invalid' : 'input'}
        name="account"
        autocomplete="username"
        placeholder="请输入账号 / 邮箱"
        value={account()}
        onInput={(event) => {
          const target = event.target as HTMLInputElement | null;
          account.set(target?.value ?? '');
          status.set('idle');
        }}
        onBlur={() => accountTouched.set(true)}
      />
      <When when={accountInvalid()}>
        <p className="hint">请输入账号后再继续。</p>
      </When>
    </label>

    <label className="field">
      <span>密码</span>
      <span className="control">
        <input
          className={passwordInvalid() ? 'input is-invalid' : 'input'}
          type={passwordVisible() ? 'text' : 'password'}
          name="password"
          autocomplete="current-password"
          value={password()}
          onInput={(event) => {
            const target = event.target as HTMLInputElement | null;
            password.set(target?.value ?? '');
            status.set('idle');
          }}
          onBlur={() => passwordTouched.set(true)}
        />
        <button
          type="button"
          aria-pressed={passwordVisible()}
          onClick={() => passwordVisible.set((value) => !value)}
        >
          {passwordVisible() ? '隐藏' : '显示'}
        </button>
      </span>
      <When when={passwordInvalid()}>
        <p className="hint">请输入密码后再继续。</p>
      </When>
    </label>

    <label>
      <input
        type="checkbox"
        checked={remember()}
        onChange={() => remember.set((value) => !value)}
      />
      记住账号
    </label>

    <button type="button" disabled={!canSubmit()} onClick={onSubmit}>
      <When when={submitting()}>
        <span className="spinner" />
      </When>
      <span>{submitting() ? '正在登录…' : '登 录'}</span>
    </button>

    <When when={status() === 'success'}>
      <div role="status">
        登录成功，欢迎回来 {account().trim() || '访客'}。
      </div>
    </When>
  </section>
);
```

### 绑定点

| 表达式 | 更新目标 |
| --- | --- |
| `value={account()}` | input property |
| `className={accountInvalid() ? ...}` | class attribute |
| `disabled={!canSubmit()}` | button property |
| `{submitting() ? ...}` | 文本 Slot |
| `<When when={...}>` | 条件 Slot |

每个表达式只订阅自己读取的 Signal / Memo。

## 样式

```ts
import { css } from '@lania-v/runtime';

export const loginStyles = css`
  :host {
    display: block;
    color: #e2e8f0;
  }

  .card {
    display: grid;
    gap: 16px;
    padding: 28px;
    border-radius: 18px;
    background: #0f172a;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  }

  .hint {
    margin: 6px 0 0;
    color: #f87171;
    font-size: 12px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;
```

```ts
LoginPage.styles = loginStyles;
```

## 挂载

```tsx
import { createRoot } from '@lania-v/runtime';
import LoginPage from './LoginPage.lania.tsx';
import { loginStyles } from './login-styles';

LoginPage.styles = loginStyles;

createRoot(document.querySelector('#app')!).render(<LoginPage />);
```

## 观察更新

给 Vite 插件开启 `debug: true`：

```ts
laniaFcVitePlugin({ debug: true });
```

控制台可以观察：

```text
[lania-v] compile: LoginPage
  TSX / FC
  Component IR
  renderPlan
  Generated module
```

操作表单时：

```js
__lania.trace.slice(-10);
```

可以看到：

```text
Signal.set
Scheduler.schedule
Scheduler.flush-start
Updater.run
Slot.write
Scheduler.flush-end
```

## 可以继续练习

1. 用 `createStore` 替代多个 Signal；
2. 用 `useFormValidity` 把校验接入原生表单；
3. 用 `Await` 模拟真实登录请求；
4. 用 `ErrorBoundary` 捕获请求错误；
5. 用 `Transition` 给错误提示加入动画。
