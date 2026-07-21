import { create } from "zustand";

interface UiState {
  systemDialogOpen: boolean;
  setSystemDialogOpen: (open: boolean) => void;
}

// Zustand is intentionally limited to page chrome. Messages, runs and shared
// Agent state remain owned by HttpAgent and, later, the backend persistence layer.
export const useUiStore = create<UiState>((set) => ({
  systemDialogOpen: false,
  setSystemDialogOpen: (systemDialogOpen) => set({ systemDialogOpen }),
}));
