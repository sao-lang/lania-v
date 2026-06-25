type RuntimeIntrinsicElementProps =
  import('@lania-v/runtime/jsx-runtime').LaniaIntrinsicElementProps<HTMLElement>;
type RuntimeNativeIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaNativeIntrinsicElements;
type RuntimeEnhancedIntrinsicElements =
  import('@lania-v/runtime/jsx-runtime').LaniaEnhancedIntrinsicElements;

declare namespace JSX {
  type Element = import('@lania-v/runtime/jsx-runtime').LaniaJsxElement;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: unknown;
  }
  interface IntrinsicElements
    extends RuntimeNativeIntrinsicElements,
      RuntimeEnhancedIntrinsicElements,
      Record<string, RuntimeIntrinsicElementProps> {}
}
