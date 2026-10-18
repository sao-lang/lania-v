import {
  createMemo,
  createSignal,
  defineComponent,
  useFormValue,
  When,
} from '@lania-v/runtime';
import { readRememberedAccount, writeRememberedAccount } from './login-storage';
// import { watch } from '@lania-v/runtime';
import { createEffect } from '@lania-v/runtime';
import { onMount } from '@lania-v/runtime';

type LoginStatus = 'idle' | 'submitting' | 'success';

export default defineComponent(function LoginPage() {
  const submitDelayMs = 700;
  const rememberedAccount = readRememberedAccount();
  const account = createSignal(rememberedAccount);
  const password = createSignal('');
  const remember = createSignal(rememberedAccount.length > 0);

  // 让宿主元素参与原生表单提交：<form> 里提交时会带上当前账号。
  useFormValue(() => account());
  const passwordVisible = createSignal(false);
  const status = createSignal<LoginStatus>('idle');
  const accountTouched = createSignal(false);
  const passwordTouched = createSignal(false);

  let submitTimer: ReturnType<typeof setTimeout> | null = null;

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
  // watch(password, (current) => {
  //   console.log({ current });
  // });
  createEffect(() => {
    console.log({ account: account() });
    console.log({ passwordLength: password().length });
  });

  const readInputValue = (event: Event): string => {
    const target = event.target as HTMLInputElement | null;
    return target?.value ?? '';
  };

  const onChangeAccount = (event: Event) => {
    account.set(readInputValue(event));
    status.set('idle');
  };

  const onChangePassword = (event: Event) => {
    password.set(readInputValue(event));
    status.set('idle');
  };

  onMount(() => {
    console.log({ account: account, accountMissing: accountMissing });
  });

  const onSubmit = () => {
    accountTouched.set(true);
    passwordTouched.set(true);
    if (!canSubmit()) return;
    status.set('submitting');
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      submitTimer = null;
      writeRememberedAccount(remember() ? account().trim() : '');
      status.set('success');
    }, submitDelayMs);
  };

  const onFieldKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Enter') onSubmit();
  };

  return (
    <section className="card" data-debug="login-page">
      <div className="brand">
        <span className="brand-mark">L</span>
        <span className="brand-text">
          <span className="brand-name">lania-v</span>
          <span className="brand-tag">
            编译优先的细粒度 Web Components 框架
          </span>
        </span>
      </div>

      <div className="headline">
        <h1>欢迎回来</h1>
        <p>登录后继续查看编译产物与运行时演示。</p>
      </div>

      <label className="field">
        <span className="field-label">账号</span>
        <span className={accountInvalid() ? 'control is-invalid' : 'control'}>
          <input
            className="input"
            type="text"
            name="account"
            autocomplete="username"
            placeholder="请输入账号 / 邮箱"
            value={account()}
            onInput={onChangeAccount}
            onBlur={() => accountTouched.set(true)}
            onKeyDown={onFieldKeyDown}
          />
        </span>
        <When when={accountInvalid()}>
          <p className="hint">请输入账号后再继续。</p>
        </When>
      </label>

      <label className="field">
        <span className="field-label">密码</span>
        <span className={passwordInvalid() ? 'control is-invalid' : 'control'}>
          <input
            className="input"
            type={passwordVisible() ? 'text' : 'password'}
            name="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            value={password()}
            onInput={onChangePassword}
            onBlur={() => passwordTouched.set(true)}
            onKeyDown={onFieldKeyDown}
          />
          <button
            className="toggle"
            type="button"
            aria-pressed={passwordVisible()}
            onClick={() => passwordVisible.set(!passwordVisible())}
          >
            {passwordVisible() ? '隐藏' : '显示'}
          </button>
        </span>
        <When when={passwordInvalid()}>
          <p className="hint">请输入密码后再继续。</p>
        </When>
      </label>

      <div className="options">
        <label className="remember">
          <input
            type="checkbox"
            checked={remember()}
            onChange={() => remember.set(!remember())}
          />
          <span>记住账号</span>
        </label>
        <span className="env-note">演示环境 · 任意账号密码均可登录</span>
      </div>

      <button
        className="submit"
        type="button"
        disabled={!canSubmit()}
        onClick={onSubmit}
      >
        <When when={submitting()}>
          <span className="spinner"></span>
        </When>
        <span>{submitting() ? '正在登录…' : '登 录'}</span>
      </button>

      <When when={status() === 'success'}>
        <div className="banner" role="status">
          <span className="banner-check">✓</span>
          <span>
            登录成功，欢迎回来 {account().trim() || '访客'}。
            {remember() ? '账号已记住。' : ''}
          </span>
        </div>
      </When>
    </section>
  );
});
