import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, EmptyState } from '../ui';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, retry: () => void) => ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Non-fatal — surface via console so the operator can open devtools.
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label ?? 'ErrorBoundary'}] caught:`, error, info);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
      return (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title={`${this.props.label ?? 'This section'} failed to load.`}
          description={this.state.error.message}
          action={
            <Button size="sm" onClick={this.retry}>
              Try again
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
