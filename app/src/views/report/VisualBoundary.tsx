import { Component, type ReactNode } from "react";

/** A visual that throws while it is built or drawn shows a message in its own frame; the rest of the report (and the window) keeps working. */
export class VisualBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: string | null; key?: unknown }> {
  state = { error: null as string | null, key: this.props.resetKey };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: string | null; key?: unknown }) {
    // a change to the visual (its JSON) gets another try
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  render() {
    if (this.state.error !== null) return <div role="alert" style={{ padding: 12, fontSize: 12, color: "#c50f1f" }}>Cannot draw this visual: {this.state.error}</div>;
    return this.props.children;
  }
}
