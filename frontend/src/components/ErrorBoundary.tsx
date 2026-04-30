import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from './ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('CruX renderer error boundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-background p-6">
          <div className="glass-card flex max-w-xl flex-col gap-4 rounded-3xl p-8">
            <p className="text-sm uppercase tracking-[0.35em] text-rose-300/80">CruX Recovery</p>
            <h1 className="text-2xl font-semibold text-white">The renderer hit an unexpected error.</h1>
            <p className="text-sm text-muted-foreground">{this.state.errorMessage}</p>
            <div className="flex gap-3">
              <Button onClick={() => window.location.reload()}>Reload CruX</Button>
              <Button variant="outline" onClick={() => this.setState({ hasError: false, errorMessage: '' })}>
                Try Again
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
