declare global {
  interface Window {
    desktop?: {
      platform?: string;
      version?: string;
      onFocusInput?: (handler: () => void) => () => void;
      focusWindow?: () => void;
      notify?: (payload: { title?: string; body?: string; silent?: boolean }) => void;
      getWindowState?: () => Promise<{ focused: boolean; visible: boolean }>;
      trackBackgroundRun?: (payload: { runId: string; title?: string }) => void;
    };
  }
}

export {};
