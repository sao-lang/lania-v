import { registerDirective } from '@lania-v/runtime';

export type PlaygroundWatermarkValue = {
  text: string;
  tone: 'violet' | 'emerald';
  rotate: number;
  onPhase?: (
    phase: 'mounted' | 'updated' | 'unmounted',
    value?: PlaygroundWatermarkValue,
    oldValue?: PlaygroundWatermarkValue
  ) => void;
};

const watermarkDirectiveCallbacks = new WeakMap<
  HTMLElement,
  NonNullable<PlaygroundWatermarkValue['onPhase']>
>();
const watermarkLayers = new WeakMap<HTMLElement, HTMLDivElement>();

const createWatermarkOverlay = (): HTMLDivElement => {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-watermark-layer', '');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.overflow = 'hidden';
  overlay.style.display = 'grid';
  overlay.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  overlay.style.alignContent = 'space-between';
  overlay.style.justifyItems = 'center';
  overlay.style.padding = '20px 12px';
  overlay.style.zIndex = '1';
  overlay.style.userSelect = 'none';
  return overlay;
};

const applyPlaygroundWatermark = (
  el: HTMLElement,
  value: Omit<PlaygroundWatermarkValue, 'onPhase'>
) => {
  const color =
    value.tone === 'violet'
      ? 'rgba(196,181,253,0.28)'
      : 'rgba(110,231,183,0.28)';
  const overlay = watermarkLayers.get(el) ?? createWatermarkOverlay();
  const marks = Array.from({ length: 9 }, () => value.text);

  el.dataset.watermark = value.text;
  el.dataset.watermarkTone = value.tone;
  el.dataset.watermarkRotate = String(value.rotate);
  el.style.borderColor = value.tone === 'violet' ? '#8b5cf6' : '#10b981';
  el.style.position = 'relative';
  el.style.overflow = 'hidden';

  overlay.innerHTML = marks
    .map(
      (text) =>
        `<span style="display:block;transform:rotate(${value.rotate}deg);color:${color};font-size:18px;font-weight:700;letter-spacing:2px;white-space:nowrap;">${text}</span>`
    )
    .join('');

  if (!watermarkLayers.has(el)) {
    el.appendChild(overlay);
    watermarkLayers.set(el, overlay);
  }
};

registerDirective<PlaygroundWatermarkValue>('watermark', {
  mounted(el, value) {
    applyPlaygroundWatermark(el, value);
    if (value.onPhase) {
      watermarkDirectiveCallbacks.set(el, value.onPhase);
    }
    value.onPhase?.('mounted', value);
  },
  updated(el, value, oldValue) {
    applyPlaygroundWatermark(el, value);
    if (value.onPhase) {
      watermarkDirectiveCallbacks.set(el, value.onPhase);
    }
    value.onPhase?.('updated', value, oldValue);
  },
  unmounted(el) {
    watermarkDirectiveCallbacks.get(el)?.('unmounted');
    watermarkDirectiveCallbacks.delete(el);
    watermarkLayers.get(el)?.remove();
    watermarkLayers.delete(el);
    delete el.dataset.watermark;
    delete el.dataset.watermarkTone;
    delete el.dataset.watermarkRotate;
    el.style.borderColor = '';
    el.style.position = '';
    el.style.overflow = '';
  },
});
