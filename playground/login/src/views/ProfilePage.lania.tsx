import { onMount } from '@lania-v/runtime';
import { createSignal, untrack, watch } from '@lania-v/runtime/reactivity';
import { Each, When } from '@lania-v/runtime/advanced';
import { createAtom } from '@lania-v/store';
import {
  ApiError,
  type ListUsersResult,
  type UserView,
  changePassword,
  fetchCurrentAccount,
  listUsers,
  onSessionChange,
} from '../api';

type ProfilePageProps = {
  /** 登出后由父组件切回登录视图。 */
  signedOut?: () => void;
};

type LoadState = 'loading' | 'ready' | 'error';

const PAGE_SIZE = 5;

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.status > 0
      ? `${error.message}（${error.status}）`
      : error.message;
  }
  return error instanceof Error ? error.message : '请求失败';
};

export default function ProfilePage(props: ProfilePageProps) {
  const users = createAtom<{ items: UserView[] }>({ items: [] });
  const keyword = createSignal('');
  const page = createSignal(1);
  const total = createSignal(0);
  const state = createSignal<LoadState>('loading');
  const errorText = createSignal('');

  // 头部展示当前登录账号：来自 /auth/me，点选列表项时叠加展示该用户的资料。
  const accountName = createSignal('');
  const accountMeta = createSignal('');
  const accountLoading = createSignal(true);
  const accountError = createSignal('');
  const selectedId = createSignal<number | null>(null);

  // 修改密码表单。
  const pwdOpen = createSignal(false);
  const pwdOld = createSignal('');
  const pwdNew = createSignal('');
  const pwdConfirm = createSignal('');
  const pwdBusy = createSignal(false);
  const pwdMessage = createSignal('');
  const pwdError = createSignal('');
  const pwdVisible = createSignal(false);

  const PASSWORD_MIN_LENGTH = 6;

  const pwdReady = () =>
    pwdOld.value.length > 0 &&
    pwdNew.value.length >= PASSWORD_MIN_LENGTH &&
    pwdNew.value === pwdConfirm.value;

  const pwdMismatch = () =>
    pwdConfirm.value.length > 0 && pwdConfirm.value !== pwdNew.value;

  const resetPwdForm = () => {
    pwdOld.set('');
    pwdNew.set('');
    pwdConfirm.set('');
    pwdMessage.set('');
    pwdError.set('');
  };

  const togglePwdForm = () => {
    const next = !pwdOpen.value;
    pwdOpen.set(next);
    if (!next) resetPwdForm();
  };

  const submitPasswordChange = async () => {
    if (!pwdReady() || pwdBusy.value) return;
    pwdBusy.set(true);
    pwdMessage.set('');
    pwdError.set('');
    try {
      const message = await changePassword({
        oldPassword: pwdOld.value,
        newPassword: pwdNew.value,
      });
      pwdMessage.set(message);
      pwdOld.set('');
      pwdNew.set('');
      pwdConfirm.set('');
    } catch (error) {
      pwdError.set(describeError(error));
    } finally {
      pwdBusy.set(false);
    }
  };

  const read = <T,>(source: { peek: () => T }): T => untrack(source.peek);

  const totalPages = () => Math.max(1, Math.ceil(read(total) / PAGE_SIZE));

  // 单一插值：避免多个动态文本节点相邻时只更新首个节点的渲染路径。
  const pageSummary = () =>
    `共 ${total.value} 人 · 第 ${page.value} / ${totalPages()} 页`;

  const loadUsers = async () => {
    const currentPage = read(page);
    const currentKeyword = read(keyword);
    state.set('loading');
    errorText.set('');
    try {
      const result: ListUsersResult = await listUsers({
        keyword: currentKeyword || undefined,
        page: currentPage,
        size: PAGE_SIZE,
      });
      users.set({ items: result.items });
      total.set(result.total);
      state.set('ready');
    } catch (error) {
      errorText.set(describeError(error));
      state.set('error');
    }
  };

  const loadAccount = async () => {
    accountLoading.set(true);
    accountError.set('');
    try {
      const account = await fetchCurrentAccount();
      accountName.set(account.username);
      accountMeta.set(`角色 ${account.role} · ID ${account.id}`);
    } catch (error) {
      accountError.set(describeError(error));
    } finally {
      accountLoading.set(false);
    }
  };

  const selectUser = (item: UserView) => {
    // 列表项已是完整用户视图，点选无需再请求详情接口。
    selectedId.set(item.id);
    accountName.set(item.name);
    accountMeta.set(`${item.email} · ${item.age} 岁`);
    accountError.set('');
  };

  const changePage = (delta: number) => {
    const next = read(page) + delta;
    if (next < 1 || next > totalPages()) return;
    page.set(next);
  };

  // 关键字 / 页码变化时重新拉取；immediate 让首次渲染就发起请求。
  watch([keyword, page], loadUsers, { immediate: true });

  onMount(() => {
    void loadAccount();
  });

  // token 失效或手动登出时同步回落到登录视图。
  onSessionChange((session) => {
    if (!session) props.signedOut?.();
  });

  return (
    <section className="card" data-debug="profile-page">
      <header className="profile-head">
        <div>
          <p className="eyebrow">当前登录</p>
          <h1>{accountName.value || '载入中…'}</h1>
          <p className="sub">{accountMeta.value || '正在获取账号信息'}</p>
        </div>
        <button className="ghost" type="button" onClick={() => togglePwdForm()}>
          {pwdOpen.value ? '收起' : '修改密码'}
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => props.signedOut?.()}
        >
          退出登录
        </button>
      </header>

      <When value={pwdOpen.value}>
        <div className="pwd-panel" data-debug="change-password">
          <label className="field">
            <span className="field-label">原密码</span>
            <span className="control">
              <input
                className="input"
                type={pwdVisible.value ? 'text' : 'password'}
                name="oldPassword"
                autocomplete="current-password"
                placeholder="请输入当前密码"
                model={{
                  source: {
                    get: () => pwdOld.value,
                    set: (value) => {
                      pwdOld.set(String(value ?? ''));
                      pwdError.set('');
                    },
                  },
                }}
                onKeyDown={{
                  handler: submitPasswordChange,
                  modifiers: { enter: true },
                }}
              />
              <button
                className="toggle"
                type="button"
                aria-pressed={pwdVisible.value}
                onClick={() => pwdVisible.set(!pwdVisible.value)}
              >
                {pwdVisible.value ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <label className="field">
            <span className="field-label">新密码</span>
            <span className="control">
              <input
                className="input"
                type={pwdVisible.value ? 'text' : 'password'}
                name="newPassword"
                autocomplete="new-password"
                placeholder="至少 6 位新密码"
                model={{
                  source: {
                    get: () => pwdNew.value,
                    set: (value) => {
                      pwdNew.set(String(value ?? ''));
                      pwdError.set('');
                    },
                  },
                }}
                onKeyDown={{
                  handler: submitPasswordChange,
                  modifiers: { enter: true },
                }}
              />
            </span>
            <When
              value={
                pwdNew.value.length > 0 &&
                pwdNew.value.length < PASSWORD_MIN_LENGTH
              }
            >
              <p className="hint">新密码至少需要 {PASSWORD_MIN_LENGTH} 位。</p>
            </When>
          </label>

          <label className="field">
            <span className="field-label">确认新密码</span>
            <span class={['control', { 'is-invalid': pwdMismatch() }]}>
              <input
                className="input"
                type={pwdVisible.value ? 'text' : 'password'}
                name="confirmPassword"
                autocomplete="new-password"
                placeholder="再次输入新密码"
                model={{
                  source: {
                    get: () => pwdConfirm.value,
                    set: (value) => {
                      pwdConfirm.set(String(value ?? ''));
                      pwdError.set('');
                    },
                  },
                }}
                onKeyDown={{
                  handler: submitPasswordChange,
                  modifiers: { enter: true },
                }}
              />
            </span>
            <When value={pwdMismatch()}>
              <p className="hint">两次输入的密码不一致。</p>
            </When>
          </label>

          <button
            className="submit submit-inline"
            type="button"
            disabled={!pwdReady() || pwdBusy.value}
            onClick={() => void submitPasswordChange()}
          >
            <When value={pwdBusy.value}>
              <span className="spinner"></span>
            </When>
            <span>{pwdBusy.value ? '正在更新…' : '更新密码'}</span>
          </button>

          <When value={pwdMessage.value.length > 0}>
            <div className="banner" role="status">
              <span className="banner-check">✓</span>
              <span>{pwdMessage.value}</span>
            </div>
          </When>
          <When value={pwdError.value.length > 0}>
            <div className="banner banner-error" role="alert">
              <span className="banner-check">!</span>
              <span>{pwdError.value}</span>
            </div>
          </When>
        </div>
      </When>

      <When value={accountLoading.value}>
        <p className="hint">正在获取用户信息…</p>
      </When>
      <When value={accountError.value.length > 0}>
        <div className="banner banner-error" role="alert">
          <span className="banner-check">!</span>
          <span>{accountError.value}</span>
        </div>
      </When>

      <div className="toolbar">
        <span className="field-label">用户列表</span>
        <span className="env-note">{pageSummary()}</span>
      </div>

      <span className="control">
        <input
          className="input"
          type="search"
          placeholder="按姓名 / 邮箱搜索"
          model={{
            source: {
              get: () => keyword.value,
              set: (value) => {
                keyword.set(String(value ?? ''));
                page.set(1);
              },
            },
          }}
        />
      </span>

      <When value={state.value === 'loading'}>
        <p className="hint">正在加载用户列表…</p>
      </When>

      <When value={state.value === 'error'}>
        <div className="banner banner-error" role="alert">
          <span className="banner-check">!</span>
          <span>{errorText.value}</span>
        </div>
      </When>

      <When value={state.value === 'ready'}>
        <ul className="user-list">
          <Each
            value={users.value.items}
            fallback={<li class="empty">没有匹配的用户</li>}
          >
            {(item: UserView): any => (
              <li
                className={[
                  'user-item',
                  { 'is-active': selectedId.value === item.id },
                ]}
                onClick={() => selectUser(item)}
              >
                <span className="user-avatar">{item.name.slice(0, 1)}</span>
                <span className="user-main">
                  <span className="user-name">
                    {item.name}
                    <span className="user-id">#{item.id}</span>
                  </span>
                  <span className="user-meta">
                    {item.email} · {item.age} 岁
                  </span>
                </span>
              </li>
            )}
          </Each>
        </ul>

        <div className="pager">
          <button
            className="ghost"
            type="button"
            disabled={page.value <= 1}
            onClick={() => changePage(-1)}
          >
            上一页
          </button>
          <button
            className="ghost"
            type="button"
            disabled={page.value >= totalPages()}
            onClick={() => changePage(1)}
          >
            下一页
          </button>
        </div>
      </When>
    </section>
  );
}
