// 后端地址允许通过环境变量覆盖，默认指向 lania-g 的 cmd/http-demo。
const rawBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080';

export const API_BASE_URL = rawBaseUrl.replace(/\/+$/, '');
