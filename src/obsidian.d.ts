import { App as ObsidianApp } from 'obsidian';
import type {
  ProgressUpdateData,
  ProgressCompleteData,
  ProgressCancelData
} from './components/ProgressBar';

// Extend the Obsidian App interface to include the version property
declare module 'obsidian' {
  interface App extends ObsidianApp {
    version: string;
  }
}

declare global {
  interface CapacitorKeyboardEvent extends Event {
    keyboardHeight?: number;
    detail?: {
      keyboardHeight?: number;
    };
  }

  interface WindowEventMap {
    keyboardWillShow: CapacitorKeyboardEvent;
    keyboardDidShow: CapacitorKeyboardEvent;
    keyboardWillHide: Event;
    keyboardDidHide: Event;
  }

  interface Window {
    app: App;
    mcpProgressHandlers?: {
      updateProgress: (data: ProgressUpdateData) => void;
      completeProgress: (data: ProgressCompleteData) => void;
      cancelProgress: (data: ProgressCancelData) => void;
    };
  }
}

export {};
