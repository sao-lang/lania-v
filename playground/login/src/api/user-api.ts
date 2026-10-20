import { request } from './http';
import { get } from './http-verbs';

/** 后端 /users 返回的用户视图。 */
export type UserView = {
  id: number;
  name: string;
  email: string;
  age: number;
};

export type ListUsersParams = {
  keyword?: string;
  page?: number;
  size?: number;
};

export type ListUsersResult = {
  items: UserView[];
  total: number;
  page: number;
  size: number;
  keyword: string;
  trace_id: string;
};

/** 分页查询用户列表（需要登录）。 */
export const listUsers = (params: ListUsersParams = {}): Promise<ListUsersResult> =>
  request<ListUsersResult>(() => get('/users', params));

/** 按 ID 查询单个用户（需要登录）。 */
export const getUser = (id: number): Promise<UserView> =>
  request<UserView>(() => get(`/users/${id}`));
