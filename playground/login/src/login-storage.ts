const REMEMBERED_ACCOUNT_KEY = 'lania-v.login.remembered-account';

export const readRememberedAccount = (): string => {
  try {
    return localStorage.getItem(REMEMBERED_ACCOUNT_KEY) ?? '';
  } catch {
    // 隐私模式下 localStorage 可能不可用，这里降级为“本次会话不记住”。
    return '';
  }
};

export const writeRememberedAccount = (value: string): void => {
  try {
    if (value) {
      localStorage.setItem(REMEMBERED_ACCOUNT_KEY, value);
    } else {
      localStorage.removeItem(REMEMBERED_ACCOUNT_KEY);
    }
  } catch {
    // 同上：写入失败不影响登录流程。
  }
};
