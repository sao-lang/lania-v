import { defineComponent, StyleBindingValue } from '@lania-v/runtime';

type ShowcaseCardProps = {
  title?: string;
  style?: StyleBindingValue;
  children?: unknown;
  // style?: Record<string, unknown>;
};

export default defineComponent(function ShowcaseCard(props: ShowcaseCardProps) {
  return (
    <section className="surface-light" style={props.style}>
      <p className="summary">{props.title ?? 'ShowcaseCard'}</p>
      <p className="empty">FC preview card</p>
      <div>{props.children as any}</div>
    </section>
  );
});
