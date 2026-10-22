import { LocalStorageHelper } from '@lania-tools/tools/web-storage-helper';

/**
 * 登录态存储：内存缓存 + `LocalStorageHelper`（lania-tools）持久化。
 *
 * - `AxiosWrapper` 的 tokenProvider 需要同步取值，因此模块加载时读一次并常驻内存；
 * - 持久化统一走工具的 `encryptData`，localStorage 里不会出现明文 token。
 */
const SESSION_KEY = 'lania-v.auth.session';
// 演示环境：会话 7 天过期，避免过期 token 被长期当作“已登录”。
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const STORAGE_OPTIONS = {
  encryptData: true,
  expiresInSeconds: SESSION_TTL_SECONDS,
};

export type AuthSession = {
  token: string;
  username: string;
  role: string;
};

export type AuthSessionListener = (session: AuthSession | null) => void;

const listeners = new Set<AuthSessionListener>();

const isSession = (value: unknown): value is AuthSession => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === 'string' &&
    typeof record.username === 'string' &&
    typeof record.role === 'string'
  );
};

const readFromStorage = (): AuthSession | null => {
  try {
    const stored = LocalStorageHelper.get<unknown>(SESSION_KEY);
    return isSession(stored) ? stored : null;
  } catch {
    // 隐私模式下 localStorage 不可用：按未登录处理。
    return null;
  }
};

let current = readFromStorage();

export const getSession = (): AuthSession | null => current;

export const getToken = (): string => current?.token ?? '';

const emit = (): void => {
  listeners.forEach((listener) => listener(current));
};

export const setSession = (session: AuthSession): void => {
  current = session;
  try {
    LocalStorageHelper.set(SESSION_KEY, session, STORAGE_OPTIONS);
  } catch {
    // 写入失败不影响本次会话内继续使用登录态。
  }
  emit();
};

export const clearSession = (): void => {
  if (!current) return;
  current = null;
  try {
    LocalStorageHelper.delete(SESSION_KEY);
  } catch {
    // 同上：清理失败也不阻断登出流程。
  }
  emit();
};

export const onSessionChange = (
  listener: AuthSessionListener
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
