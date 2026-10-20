import {
  createMemo,
  defineComponent,
  onCleanup,
  onMount,
  useFormValue,
  watch,
} from '@lania-v/runtime';
import { When } from '@lania-v/advanced';
import { createAtom } from '@lania/store';
import {
  ApiError,
  type AuthSession,
  forgotPassword,
  getSession,
  login,
  logout,
  register,
} from './api';
import {
  readRememberedAccount,
  writeRememberedAccount,
  writeSignedUpAccount,
} from './login-storage';
import ProfilePage from './views/ProfilePage.lania.tsx';

type AuthMode = 'login' | 'register' | 'forgot';
type FormStatus = 'idle' | 'submitting' | 'success' | 'error';
type Role = 'member' | 'admin';

const ACCOUNT_MIN_LENGTH = 3;
const PASSWORD_MIN_LENGTH = 6;

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
};

export default defineComponent(function LoginPage() {
  const rememberedAccount = readRememberedAccount();

  // 表单是一份整体状态，用 atom 按字段路径精确订阅；写入统一走 set()。
  const form = createAtom({
    mode: 'login' as AuthMode,
    account: rememberedAccount,
    password: '',
    // 忘记密码时使用：新密码 + 二次确认。
    newPassword: '',
    confirmPassword: '',
    role: 'member' as Role,
    remember: rememberedAccount.length > 0,
    passwordVisible: false,
    status: 'idle' as FormStatus,
    message: '',
    accountTouched: false,
    passwordTouched: false,
  });

  // 登录态：初始值取本地缓存，刷新页面后先按已登录渲染，再由 /auth/me 校验。
  const session = createAtom<{ current: AuthSession | null }>({
    current: getSession(),
  });

  // 让宿主元素参与原生表单提交：<form> 里提交时会带上当前账号。
  useFormValue(() => form.value.account);

  const isRegister = createMemo(() => form.value.mode === 'register');
  const isForgot = createMemo(() => form.value.mode === 'forgot');
  const needsPassword = createMemo(() => !isForgot.value);
  const submitting = createMemo(() => form.value.status === 'submitting');
  const accountMissing = createMemo(
    () => form.value.account.trim().length < ACCOUNT_MIN_LENGTH
  );
  const passwordMissing = createMemo(
    () => form.value.password.length < PASSWORD_MIN_LENGTH
  );
  const newPasswordMissing = createMemo(
    () => form.value.newPassword.length < PASSWORD_MIN_LENGTH
  );
  const confirmMismatch = createMemo(
    () =>
      form.value.confirmPassword.length > 0 &&
      form.value.confirmPassword !== form.value.newPassword
  );
  const canSubmit = createMemo(() => {
    if (submitting.value || accountMissing.value) return false;
    if (isForgot.value) {
      return (
        !newPasswordMissing.value &&
        form.value.confirmPassword === form.value.newPassword
      );
    }
    return !passwordMissing.value;
  });
  const accountInvalid = createMemo(
    () => form.value.accountTouched && accountMissing.value
  );
  const passwordInvalid = createMemo(
    () =>
      form.value.passwordTouched && needsPassword.value && passwordMissing.value
  );

  const resetStatus = () => {
    if (form.value.status !== 'idle') {
      form.set('status', 'idle');
      form.set('message', '');
    }
  };

  const setMode = (mode: AuthMode) => {
    if (form.value.mode === mode) return;
    form.set('mode', mode);
    form.set('role', 'member');
    form.set('newPassword', '');
    form.set('confirmPassword', '');
    form.set('accountTouched', false);
    form.set('passwordTouched', false);
    resetStatus();
  };

  const onSubmit = async () => {
    // set 是整体替换，局部更新用路径写法逐字段写入。
    form.set('accountTouched', true);
    form.set('passwordTouched', true);
    if (!canSubmit.value) return;

    const account = form.value.account.trim();
    const password = form.value.password;
    const mode = form.value.mode;

    form.set('status', 'submitting');
    form.set('message', '');

    try {
      if (mode === 'register') {
        const created = await register({
          username: account,
          password,
          role: form.value.role,
        });
        writeSignedUpAccount(created.username);
        // 注册成功回到登录态并预填账号，避免用户再手动输入。
        form.set('mode', 'login');
        form.set('account', created.username);
        form.set('password', '');
        form.set('passwordTouched', false);
        form.set('status', 'success');
        form.set('message', `注册成功，请使用账号 ${created.username} 登录。`);
        return;
      }

      if (mode === 'forgot') {
        const message = await forgotPassword({
          username: account,
          newPassword: form.value.newPassword,
        });
        // 重置成功：回到登录态，密码留空由用户输入新密码。
        writeRememberedAccount(account);
        form.set('mode', 'login');
        form.set('password', '');
        form.set('newPassword', '');
        form.set('confirmPassword', '');
        form.set('remember', true);
        form.set('passwordTouched', false);
        form.set('status', 'success');
        form.set('message', `${message}（账号 ${account}）`);
        return;
      }

      const next = await login({ username: account, password });
      writeRememberedAccount(form.value.remember ? account : '');
      writeSignedUpAccount('');
      form.set('status', 'success');
      form.set('message', `欢迎回来，${next.username}。`);
      session.set('current', next);
    } catch (error) {
      form.set('status', 'error');
      form.set('message', describeError(error));
      // 后端在 token 过期时也会返回 401：只有已登录状态才需要清会话。
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        session.value.current !== null
      ) {
        signOut();
      }
    }
  };

  const signOut = () => {
    logout();
    session.set('current', null);
    form.set('mode', 'login');
    form.set('password', '');
    form.set('newPassword', '');
    form.set('confirmPassword', '');
    form.set('status', 'idle');
    form.set('message', '');
    form.set('accountTouched', false);
    form.set('passwordTouched', false);
  };

  const headline = createMemo(() => {
    if (form.value.mode === 'forgot') return '重置密码';
    return form.value.mode === 'register' ? '创建账号' : '欢迎回来';
  });

  const summary = createMemo(() => {
    if (form.value.mode === 'forgot')
      return '输入账号并设置新密码，重置后旧会话会失效。';
    return form.value.mode === 'register'
      ? '注册成功即可登录，查看真实接口返回的用户信息。'
      : '登录后继续查看编译产物与运行时演示。';
  });

  const submitLabel = createMemo(() => {
    if (submitting.value) {
      if (form.value.mode === 'forgot') return '正在重置…';
      return form.value.mode === 'register' ? '正在注册…' : '正在登录…';
    }
    if (form.value.mode === 'forgot') return '重 置 密 码';
    return form.value.mode === 'register' ? '注 册' : '登 录';
  });

  onMount(() => {
    console.log('[login] mounted', {
      authenticated: session.value.current !== null,
    });
  });

  // 只在状态真正变化时打点：getter 形式的 watch 会精确追踪 form.value.status 这一条路径，
  // 写输入框（其它字段）不会触发。
  watch(
    () => form.value.status,
    (current, previous) => {
      console.log('[login] status', previous, '->', current);
    }
  );

  onCleanup(() => {
    console.log('[login] unmounted');
  });

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

      <When when={session.value.current !== null}>
        <ProfilePage signedOut={() => signOut()} />
      </When>

      <When when={session.value.current === null}>
        <div className="headline">
          <h1>{headline.value}</h1>
          <p>{summary.value}</p>
        </div>

        <div className="tabs" role="tablist">
          <button
            className={['tab', { 'is-active': form.value.mode === 'login' }]}
            type="button"
            role="tab"
            aria-selected={form.value.mode === 'login'}
            onClick={() => setMode('login')}
          >
            登录
          </button>
          <button
            className={['tab', { 'is-active': isRegister.value }]}
            type="button"
            role="tab"
            aria-selected={isRegister.value}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        <label className="field">
          <span className="field-label">账号</span>
          <span class={['control', { 'is-invalid': accountInvalid.value }]}>
            <input
              className="input"
              type="text"
              name="username"
              autocomplete="username"
              placeholder={
                isRegister.value ? '3-20 位账号，如 alice01' : '请输入账号'
              }
              model={{
                source: {
                  get: () => form.value.account,
                  set: (value) => {
                    form.set('account', String(value ?? ''));
                    resetStatus();
                  },
                },
              }}
              onBlur={() => form.set('accountTouched', true)}
              onKeyDown={{ handler: onSubmit, modifiers: { enter: true } }}
            />
          </span>
          <When when={accountInvalid.value}>
            <p className="hint">账号至少需要 {ACCOUNT_MIN_LENGTH} 个字符。</p>
          </When>
        </label>

        <When when={needsPassword.value}>
          <label className="field">
            <span className="field-label">密码</span>
            <span class={['control', { 'is-invalid': passwordInvalid.value }]}>
              <input
                className="input"
                type={form.value.passwordVisible ? 'text' : 'password'}
                name="password"
                autocomplete={
                  isRegister.value ? 'new-password' : 'current-password'
                }
                placeholder={isRegister.value ? '至少 6 位密码' : '请输入密码'}
                model={{
                  source: {
                    get: () => form.value.password,
                    set: (value) => {
                      form.set('password', String(value ?? ''));
                      resetStatus();
                    },
                  },
                }}
                onBlur={() => form.set('passwordTouched', true)}
                onKeyDown={{ handler: onSubmit, modifiers: { enter: true } }}
              />
              <button
                className="toggle"
                type="button"
                aria-pressed={form.value.passwordVisible}
                onClick={() =>
                  form.set('passwordVisible', !form.value.passwordVisible)
                }
              >
                {form.value.passwordVisible ? '隐藏' : '显示'}
              </button>
            </span>
            <When when={passwordInvalid.value}>
              <p className="hint">密码至少需要 {PASSWORD_MIN_LENGTH} 位。</p>
            </When>
          </label>
        </When>

        <When when={isForgot.value}>
          <label className="field">
            <span className="field-label">新密码</span>
            <span class="control">
              <input
                className="input"
                type={form.value.passwordVisible ? 'text' : 'password'}
                name="newPassword"
                autocomplete="new-password"
                placeholder="至少 6 位新密码"
                model={{
                  source: {
                    get: () => form.value.newPassword,
                    set: (value) => {
                      form.set('newPassword', String(value ?? ''));
                      resetStatus();
                    },
                  },
                }}
                onKeyDown={{ handler: onSubmit, modifiers: { enter: true } }}
              />
              <button
                className="toggle"
                type="button"
                aria-pressed={form.value.passwordVisible}
                onClick={() =>
                  form.set('passwordVisible', !form.value.passwordVisible)
                }
              >
                {form.value.passwordVisible ? '隐藏' : '显示'}
              </button>
            </span>
            <When
              when={
                form.value.newPassword.length > 0 && newPasswordMissing.value
              }
            >
              <p className="hint">新密码至少需要 {PASSWORD_MIN_LENGTH} 位。</p>
            </When>
          </label>

          <label className="field">
            <span className="field-label">确认新密码</span>
            <span class={['control', { 'is-invalid': confirmMismatch.value }]}>
              <input
                className="input"
                type={form.value.passwordVisible ? 'text' : 'password'}
                name="confirmPassword"
                autocomplete="new-password"
                placeholder="再次输入新密码"
                model={{
                  source: {
                    get: () => form.value.confirmPassword,
                    set: (value) => {
                      form.set('confirmPassword', String(value ?? ''));
                      resetStatus();
                    },
                  },
                }}
                onKeyDown={{ handler: onSubmit, modifiers: { enter: true } }}
              />
            </span>
            <When when={confirmMismatch.value}>
              <p className="hint">两次输入的密码不一致。</p>
            </When>
          </label>
        </When>

        <When when={isRegister.value}>
          <label className="field">
            <span className="field-label">角色</span>
            <span className="control">
              <select
                className="input"
                name="role"
                model={{
                  source: {
                    get: () => form.value.role,
                    set: (value) => {
                      form.set('role', value === 'admin' ? 'admin' : 'member');
                      resetStatus();
                    },
                  },
                }}
              >
                <option value="member">普通用户（member）</option>
                <option value="admin">管理员（admin）</option>
              </select>
            </span>
          </label>
        </When>

        <div className="options">
          <label className="remember">
            <input
              type="checkbox"
              model={{
                prop: 'checked',
                source: {
                  get: () => form.value.remember,
                  set: (value) => form.set('remember', value === true),
                },
              }}
            />
            <span>记住账号</span>
          </label>
          <When when={!isForgot.value}>
            <button
              className="link"
              type="button"
              onClick={() => setMode('forgot')}
            >
              忘记密码？
            </button>
          </When>
        </div>

        <button
          className="submit"
          type="button"
          disabled={!canSubmit.value}
          onClick={() => void onSubmit()}
        >
          <When when={submitting.value}>
            <span className="spinner"></span>
          </When>
          <span>{submitLabel.value}</span>
        </button>

        <p className="switch-line">
          <span>
            {isForgot.value
              ? '想起密码了？'
              : isRegister.value
                ? '已有账号？'
                : '还没有账号？'}
          </span>
          <button
            className="link"
            type="button"
            onClick={() =>
              setMode(
                isForgot.value
                  ? 'login'
                  : isRegister.value
                    ? 'login'
                    : 'register'
              )
            }
          >
            {isForgot.value
              ? '返回登录'
              : isRegister.value
                ? '直接登录'
                : '立即注册'}
          </button>
        </p>

        <When when={form.value.status === 'success'}>
          <div className="banner" role="status">
            <span className="banner-check">✓</span>
            <span>{form.value.message}</span>
          </div>
        </When>

        <When when={form.value.status === 'error'}>
          <div className="banner banner-error" role="alert">
            <span className="banner-check">!</span>
            <span>{form.value.message}</span>
          </div>
        </When>
      </When>
    </section>
  );
});
