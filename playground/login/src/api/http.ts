import { AxiosWrapper } from '@lania-tools/tools/axios-wrapper';
import { API_BASE_URL } from './config';
import { clearSession, getToken, onSessionChange } from './auth-session';
/** lania-g 统一响应信封。 */
export type ApiEnvelope<T> = {
  msg: string;
  code: number;
  data: T;
  success: boolean;
};

/** 归一化后的请求错误，UI 只需要关心 status / message。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(message: string, status: number, code: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type ErrorLike = {
  response?: { status?: number; data?: Partial<ApiEnvelope<unknown>> };
  status?: number;
  data?: Partial<ApiEnvelope<unknown>>;
  code?: string;
  message?: string;
};

const networkMessage = `无法连接后端服务（${API_BASE_URL}），请确认 cmd/http-demo 已启动`;

/** 把 axios 错误 / 信封错误 / 自定义响应统一转换成 ApiError 字段。 */
const toApiError = (error: unknown): ApiError => {
  const err = (error ?? {}) as ErrorLike;
  const envelope = err.response?.data ?? err.data;
  const status = err.response?.status ?? err.status ?? envelope?.code ?? 0;

  // 只有真正没有拿到响应（DNS / 连接被拒 / 超时）才提示“连不上”，
  // 否则优先透出后端返回的 msg，避免把 500 误报成网络故障。
  const isNetworkFailure =
    !err.response &&
    (err.code === 'ERR_NETWORK' || err.code === 'ECONNABORTED');
  const message =
    (typeof envelope?.msg === 'string' && envelope.msg.trim()) ||
    (isNetworkFailure ? networkMessage : err.message || '请求失败，请稍后重试');

  return new ApiError(message, status, envelope?.code ?? status);
};

/**
 * 登录态失效时的统一处理：清掉本地会话，让页面回到登录表单。
 * 登录 / 注册接口本身返回 401 时不应触发（那是账号密码错误），由调用方显式跳过。
 */
const handleUnauthorized = (): void => {
  clearSession();
};

const client = new AxiosWrapper(
  {
    baseURL: API_BASE_URL,
    timeout: 10_000,
    headers: { 'Content-Type': 'application/json' },
  },
  {
    // AxiosWrapper 内部会拼上 "Bearer " 前缀，这里只返回裸 token。
    tokenProvider: () => getToken(),
    accessTokenExpiredCodes: [401],
    refreshTokenExpiredCodes: [401],
    onRefreshTokenExpired: handleUnauthorized,
    // 统一解包信封：后续业务代码只拿 `data`。
    // 这里用 any 接收，避免与 lania-tools 自带 axios 的类型来源冲突。
    responseHandler: (res: any) => {
      const envelope = res.data as ApiEnvelope<unknown>;
      if (!envelope || typeof envelope !== 'object') {
        throw new ApiError('响应格式异常', res.status, res.status);
      }
      if (!envelope.success) {
        throw new ApiError(
          envelope.msg || '请求失败',
          envelope.code,
          envelope.code
        );
      }
      res.data = envelope.data;
      return res;
    },
    onError: (error: any) => {
      const { status } = toApiError(error);
      if (status === 401 && !getToken()) handleUnauthorized();
    },
  }
);

// 本地会话被清空时（例如手动登出），同步取消在途请求，避免旧 token 的响应回填 UI。
onSessionChange((session) => {
  if (!session) client.cancelAllRequests();
});

export const request = async <T>(run: () => Promise<any>): Promise<T> => {
  try {
    const response = await run();
    return response.data as T;
  } catch (error) {
    throw toApiError(error);
  }
};

export { client, toApiError };
