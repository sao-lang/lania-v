import { css } from '@lania-v/runtime';

// 组件作用域样式：优先走 shadow root 的 adoptedStyleSheets，
// 所以卡片自身的视觉全部写在 :host 和内部 class 上，不依赖页面全局 CSS。
export const loginStyles = css`
  :host {
    display: block;
    width: 100%;
    max-width: 420px;
    color: rgba(255, 255, 255, 0.92);
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial,
      'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  * {
    box-sizing: border-box;
  }

  .card {
    position: relative;
    padding: 32px 30px 28px;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.045));
    box-shadow:
      0 24px 70px rgba(0, 0, 0, 0.55),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(18px);
    overflow: hidden;
  }

  .card::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(167, 139, 250, 0.75), transparent);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-mark {
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border-radius: 12px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: #ffffff;
    background: linear-gradient(135deg, #8b5cf6, #6366f1 55%, #3b82f6);
    box-shadow:
      0 12px 28px rgba(99, 102, 241, 0.38),
      inset 0 1px 0 rgba(255, 255, 255, 0.35);
  }

  .brand-text {
    display: grid;
    gap: 2px;
  }

  .brand-name {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.4px;
  }

  .brand-tag {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    letter-spacing: 0.3px;
  }

  .headline {
    margin: 26px 0 0;
  }

  .headline h1 {
    margin: 0;
    font-size: 23px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }

  .headline p {
    margin: 8px 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.6);
  }

  .field {
    display: grid;
    gap: 7px;
    margin-top: 18px;
  }

  .field-label {
    font-size: 12px;
    letter-spacing: 0.3px;
    color: rgba(255, 255, 255, 0.66);
  }

  .control {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 46px;
    padding: 0 14px;
    border-radius: 13px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.045);
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      background 160ms ease;
  }

  .control:hover {
    background: rgba(255, 255, 255, 0.062);
  }

  .control:focus-within {
    border-color: rgba(167, 139, 250, 0.7);
    background: rgba(255, 255, 255, 0.07);
    box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.2);
  }

  .control.is-invalid {
    border-color: rgba(248, 113, 113, 0.6);
    box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.14);
  }

  .input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 14px;
    letter-spacing: 0.2px;
  }

  .input::placeholder {
    color: rgba(255, 255, 255, 0.32);
  }

  .input:-webkit-autofill {
    -webkit-text-fill-color: rgba(255, 255, 255, 0.92);
  }

  .toggle {
    flex: 0 0 auto;
    border: 0;
    padding: 4px 2px;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.58);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: color 140ms ease;
  }

  .toggle:hover {
    color: rgba(255, 255, 255, 0.9);
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: rgba(248, 113, 113, 0.92);
  }

  .options {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
  }

  .remember {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
    cursor: pointer;
    user-select: none;
  }

  .remember input {
    width: 16px;
    height: 16px;
    margin: 0;
    cursor: pointer;
    accent-color: #8b5cf6;
  }

  .env-note {
    font-size: 11px;
    letter-spacing: 0.2px;
    color: rgba(255, 255, 255, 0.42);
  }

  .submit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 48px;
    margin-top: 22px;
    border: 0;
    border-radius: 13px;
    color: #ffffff;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.6px;
    cursor: pointer;
    background: linear-gradient(135deg, #8b5cf6, #6366f1 55%, #3b82f6);
    box-shadow: 0 16px 36px rgba(99, 102, 241, 0.34);
    transition:
      transform 120ms ease,
      filter 180ms ease,
      box-shadow 180ms ease;
  }

  .submit:hover:not(:disabled) {
    filter: brightness(1.07);
    box-shadow: 0 20px 44px rgba(99, 102, 241, 0.44);
  }

  .submit:active:not(:disabled) {
    transform: translateY(1px);
  }

  .submit:disabled {
    cursor: not-allowed;
    filter: grayscale(0.4) brightness(0.82);
    box-shadow: none;
  }

  .spinner {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #ffffff;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 18px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid rgba(52, 211, 153, 0.35);
    background: rgba(16, 185, 129, 0.12);
    font-size: 13px;
    line-height: 1.55;
    color: #b5f2d8;
    animation: rise 280ms ease;
  }

  .banner-check {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(16, 185, 129, 0.92);
    color: #04231a;
    font-size: 11px;
    font-weight: 700;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
`;
