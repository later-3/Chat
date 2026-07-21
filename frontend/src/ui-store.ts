import { create } from "zustand";

interface UiState {
  systemDialogOpen: boolean;
  setSystemDialogOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  systemDialogOpen: false,
  setSystemDialogOpen: (systemDialogOpen) => set({ systemDialogOpen }),
}));
