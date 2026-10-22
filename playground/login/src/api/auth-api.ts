import { request } from './http';
import {
  type AuthSession,
  clearSession,
  getSession,
  setSession,
} from './auth-session';
import { get, post } from './http-verbs';

/** 后端 /auth/* 返回的账号视图。 */
export type AccountView = {
  id: number;
  username: string;
  role: string;
};

export type LoginPayload = {
  username: string;
  password: string;
};

export type RegisterPayload = {
  username: string;
  password: string;
  role: 'admin' | 'member';
};

export type RegisterResult = {
  account: AccountView;
};

export type LoginResult = {
  token: string;
  account: AccountView;
};

const toSession = (token: string, account: AccountView): AuthSession => ({
  token,
  username: account.username,
  role: account.role,
});

/** 注册：后端成功返回 201 与新建的账号视图。 */
export const register = (payload: RegisterPayload): Promise<AccountView> =>
  request<RegisterResult>(() => post('/auth/register', payload)).then(
    (result) => result.account
  );

/** 登录成功后立即写入本地会话，后续请求会自动带上 Bearer token。 */
export const login = async (payload: LoginPayload): Promise<AuthSession> => {
  const result = await request<LoginResult>(() => post('/auth/login', payload));
  const session = toSession(result.token, result.account);
  setSession(session);
  return session;
};

/** 拉取当前登录账号；远端结果是权威值，顺带刷新本地会话。 */
export const fetchCurrentAccount = async (): Promise<AccountView> => {
  const account = await request<AccountView>(() => get('/auth/me'));
  const session = getSession();
  if (session) {
    setSession({ ...session, username: account.username, role: account.role });
  }
  return account;
};

/** 后端没有登出接口，会话只存在于内存 / localStorage，前端丢弃即可。 */
export const logout = (): void => {
  clearSession();
};

export type ForgotPasswordPayload = {
  username: string;
  newPassword: string;
};

/** 忘记密码：后端校验账号存在后重置密码（重置会让该账号旧会话失效）。 */
export const forgotPassword = (
  payload: ForgotPasswordPayload
): Promise<string> =>
  request<{ account: AccountView; message: string }>(() =>
    post('/auth/forgot-password', payload)
  ).then((result) => result.message);

export type ChangePasswordPayload = {
  oldPassword: string;
  newPassword: string;
};

/** 修改密码：需要登录态，原密码错误时后端返回 400。 */
export const changePassword = (
  payload: ChangePasswordPayload
): Promise<string> =>
  request<{ account: AccountView; message: string }>(() =>
    post('/auth/change-password', payload)
  ).then((result) => result.message);
