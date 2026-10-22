import { client, toApiError } from './http';

/** 统一包装 AxiosWrapper 调用：拦截器解包信封，错误归一化成 ApiError。 */
const send = async (run: () => Promise<any>): Promise<any> => {
  try {
    return await run();
  } catch (error) {
    throw toApiError(error);
  }
};

export const get = (url: string, params?: unknown) =>
  send(() => client.get(url, params));

export const post = (url: string, body?: unknown) =>
  send(() => client.post(url, body));

export const put = (url: string, body?: unknown) =>
  send(() => client.put(url, body));

export const del = (url: string, params?: unknown) =>
  send(() => client.delete(url, params));
