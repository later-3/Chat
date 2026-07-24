import { CircleAlert, RotateCcw, X } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  featureName: string;
  resetKey: string;
  onClose?: () => void;
}

interface State {
  error: Error | null;
  resetKey: string;
}

export class FeatureErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey)
      return {
        error: null,
        resetKey: props.resetKey,
      };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("feature_render_failed", {
      feature: this.props.featureName,
      error: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="feature-error-boundary" role="alert">
        <CircleAlert size={24} />
        <div>
          <strong>{this.props.featureName}暂时没有加载成功</strong>
          <p>聊天和当前会话不会丢失。你可以重试，或先关闭这个区域继续对话。</p>
          <details>
            <summary>查看错误信息</summary>
            <code>{this.state.error.message}</code>
          </details>
          <footer>
            {this.props.onClose && (
              <button onClick={this.props.onClose} type="button">
                <X size={16} />
                先关闭
              </button>
            )}
            <button
              className="feature-error-retry"
              onClick={() => this.setState({ error: null })}
              type="button"
            >
              <RotateCcw size={16} />
              重新加载
            </button>
          </footer>
        </div>
      </section>
    );
  }
}
