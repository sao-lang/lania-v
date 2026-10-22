import { LocalStorageHelper } from '@lania-tools/tools/web-storage-helper';

// 只保存账号与“最近注册”提示，token 由 api/auth-session.ts 单独管理。
const REMEMBERED_ACCOUNT_KEY = 'lania-v.login.remembered-account';
const SIGNED_UP_ACCOUNT_KEY = 'lania-v.login.signed-up-account';
// 记住账号 30 天，注册提示只留 10 分钟。
const REMEMBERED_OPTIONS = { expiresInSeconds: 30 * 24 * 60 * 60 };
const SIGNED_UP_OPTIONS = { expiresInSeconds: 10 * 60 };

const readString = (key: string): string => {
  try {
    const value = LocalStorageHelper.get<unknown>(key);
    return typeof value === 'string' ? value : '';
  } catch {
    // 隐私模式下 localStorage 可能不可用，这里降级为“本次会话不记住”。
    return '';
  }
};

const writeString = (
  key: string,
  value: string,
  options: { expiresInSeconds?: number }
): void => {
  try {
    if (value) {
      LocalStorageHelper.set(key, value, options);
    } else {
      LocalStorageHelper.delete(key);
    }
  } catch {
    // 同上：写入失败不影响登录流程。
  }
};

export const readRememberedAccount = (): string =>
  readString(REMEMBERED_ACCOUNT_KEY);

export const writeRememberedAccount = (value: string): void =>
  writeString(REMEMBERED_ACCOUNT_KEY, value, REMEMBERED_OPTIONS);

/** 记录最近一次注册成功的账号，刷新后仍可提示“注册成功，请登录”。 */
export const readSignedUpAccount = (): string =>
  readString(SIGNED_UP_ACCOUNT_KEY);

export const writeSignedUpAccount = (value: string): void =>
  writeString(SIGNED_UP_ACCOUNT_KEY, value, SIGNED_UP_OPTIONS);
