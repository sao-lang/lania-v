# 示例：登录表单

这个示例来自 `playground/login/src/LoginPage.lania.tsx`，覆盖：

- 表单状态与校验；
- `createMemo` 派生；
- `createEffect`；
- `onMount`；
- `When`；
- `useFormValue` 表单关联；
- 组件样式与 Shadow DOM。

## 完整流程：注册 / 登录 / 用户信息

页面不再是纯静态演示，而是接入了 [`@lania-tools/tools`](https://www.npmjs.com/package/@lania-tools/tools) 的 `AxiosWrapper`，
对接 `lania-g` 的 `cmd/http-demo`（默认 `http://127.0.0.1:8080`，可用 `VITE_API_BASE_URL` 覆盖）。

目录结构：

| 文件                              | 职责                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/api/config.ts`               | 后端地址（环境变量兜底）                                                                      |
| `src/api/http.ts`                 | `AxiosWrapper` 实例：Bearer 注入、信封解包、错误归一化                                        |
| `src/api/http-verbs.ts`           | 极薄的 `get/post/put/delete` 包装                                                             |
| `src/api/auth-session.ts`         | 登录态（内存 + `LocalStorageHelper` 加密持久化）与订阅                                        |
| `src/api/auth-api.ts`             | `register` / `login` / `forgotPassword` / `changePassword` / `fetchCurrentAccount` / `logout` |
| `src/api/user-api.ts`             | `listUsers` / `getUser`                                                                       |
| `src/views/ProfilePage.lania.tsx` | 登录后的账号信息 + 用户列表（搜索 / 分页）+ 修改密码                                          |

### 本地存储

`localStorage` 统一走 lania-tools 的 `LocalStorageHelper`，不再手写读写：

```ts
import { LocalStorageHelper } from '@lania-tools/tools/web-storage-helper';

// 登录态：加密 + 7 天过期
LocalStorageHelper.set('lania-v.auth.session', session, {
  encryptData: true,
  expiresInSeconds: 7 * 24 * 60 * 60,
});
const restored = LocalStorageHelper.get<AuthSession>('lania-v.auth.session');
```

| key                                | 内容                    | 选项       |
| ---------------------------------- | ----------------------- | ---------- |
| `lania-v.auth.session`             | token / username / role | 加密，7 天 |
| `lania-v.login.remembered-account` | 记住的账号              | 30 天      |
| `lania-v.login.signed-up-account`  | 最近注册成功提示        | 10 分钟    |

### 忘记密码 / 修改密码

`cmd/http-demo` 提供两个接口：

| 接口                         | 鉴权   | 说明                                                                    |
| ---------------------------- | ------ | ----------------------------------------------------------------------- |
| `POST /auth/forgot-password` | 公开   | `{ username, newPassword }`；账号不存在 404，成功后该账号旧会话全部失效 |
| `POST /auth/change-password` | Bearer | `{ oldPassword, newPassword }`；原密码错误 400                          |

前端在登录表单里有「忘记密码？」入口（新密码 + 二次确认），登录后在用户信息页有「修改密码」面板。

两个容易踩坑的点：

1. `tokenProvider` 只返回**裸 token**——`AxiosWrapper` 内部会自己拼 `Bearer` 前缀。
2. 子组件的回调 prop 不要用 `onXxx` 命名——编译器会把它当作事件绑定（`__lania_events`），
   组件里读不到该 prop。示例中使用 `signedOut` 这类普通命名。

```tsx
const client = new AxiosWrapper(
  {
    baseURL: API_BASE_URL,
    timeout: 10_000,
    headers: { 'Content-Type': 'application/json' },
  },
  {
    tokenProvider: () => getToken(),
    // 统一解包后端信封 { msg, code, data, success }
    responseHandler: (res: any) => {
      const envelope = res.data;
      if (!envelope.success)
        throw new ApiError(envelope.msg, envelope.code, envelope.code);
      res.data = envelope.data;
      return res;
    },
    onRefreshTokenExpired: () => clearSession(),
  }
);
```

## 状态与校验

```tsx
import {
  createEffect,
  createMemo,
  createSignal,
  defineComponent,
  onMount,
  useFormValue,
} from '@lania-v/runtime';
import { When } from '@lania-v/runtime/advanced';

type LoginStatus = 'idle' | 'submitting' | 'success';

export default defineComponent(function LoginPage() {
  const account = createSignal('');
  const password = createSignal('');
  const remember = createSignal(false);
  const passwordVisible = createSignal(false);
  const status = createSignal<LoginStatus>('idle');
  const accountTouched = createSignal(false);
  const passwordTouched = createSignal(false);

  const accountMissing = createMemo(() => account.value.trim().length === 0);
  const passwordMissing = createMemo(() => password.value.length === 0);
  const submitting = createMemo(() => status() === 'submitting');
  const canSubmit = createMemo(
    () => !accountMissing.value && !passwordMissing.value && !submitting.value
  );
  const accountInvalid = createMemo(
    () => accountTouched.value && accountMissing.value
  );
  const passwordInvalid = createMemo(
    () => passwordTouched.value && passwordMissing.value
  );

  useFormValue(() => account.value);

  createEffect(() => {
    console.log('account changed:', account.value);
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
useFormValue(() => account.value);
```

编译后：

- 组件类生成 `static formAssociated = true`；
- 生成一个 effect Updater，`account` 变化时调用 `_setFormValue(account.value)`。

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

  if (!canSubmit.value) return;

  status.set('submitting');

  setTimeout(() => {
    status.set('success');
  }, 700);
};
```

`canSubmit.value` 读取三个 Memo，因此按钮的 `disabled` 会精确更新。

## 模板

```tsx
return (
  <section className="card">
    <h1>欢迎回来</h1>

    <label className="field">
      <span>账号</span>
      <input
        className={accountInvalid.value ? 'input is-invalid' : 'input'}
        name="account"
        autocomplete="username"
        placeholder="请输入账号 / 邮箱"
        value={account.value}
        onInput={(event) => {
          const target = event.target as HTMLInputElement | null;
          account.set(target?.value ?? '');
          status.set('idle');
        }}
        onBlur={() => accountTouched.set(true)}
      />
      <When when={accountInvalid.value}>
        <p className="hint">请输入账号后再继续。</p>
      </When>
    </label>

    <label className="field">
      <span>密码</span>
      <span className="control">
        <input
          className={passwordInvalid.value ? 'input is-invalid' : 'input'}
          type={passwordVisible.value ? 'text' : 'password'}
          name="password"
          autocomplete="current-password"
          value={password.value}
          onInput={(event) => {
            const target = event.target as HTMLInputElement | null;
            password.set(target?.value ?? '');
            status.set('idle');
          }}
          onBlur={() => passwordTouched.set(true)}
        />
        <button
          type="button"
          aria-pressed={passwordVisible.value}
          onClick={() => passwordVisible.set((value) => !value)}
        >
          {passwordVisible.value ? '隐藏' : '显示'}
        </button>
      </span>
      <When when={passwordInvalid.value}>
        <p className="hint">请输入密码后再继续。</p>
      </When>
    </label>

    <label>
      <input
        type="checkbox"
        checked={remember.value}
        onChange={() => remember.set((value) => !value)}
      />
      记住账号
    </label>

    <button type="button" disabled={!canSubmit.value} onClick={onSubmit}>
      <When when={submitting.value}>
        <span className="spinner" />
      </When>
      <span>{submitting.value ? '正在登录…' : '登 录'}</span>
    </button>

    <When when={status() === 'success'}>
      <div role="status">
        登录成功，欢迎回来 {account.value.trim() || '访客'}。
      </div>
    </When>
  </section>
);
```

### 绑定点

| 表达式                                   | 更新目标        |
| ---------------------------------------- | --------------- |
| `value={account.value}`                  | input property  |
| `className={accountInvalid.value ? ...}` | class attribute |
| `disabled={!canSubmit.value}`            | button property |
| `{submitting.value ? ...}`               | 文本 Slot       |
| `<When when={...}>`                      | 条件 Slot       |

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

1. 用 `@lania-v/store` 的 `createAtom` 替代多个 Signal；
2. 用 `useFormValidity` 把校验接入原生表单；
3. 用 `Await` 模拟真实登录请求；
4. 用 `ErrorBoundary` 捕获请求错误；
5. 用 `Transition` 给错误提示加入动画。
