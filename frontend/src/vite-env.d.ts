/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_AG_UI_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WEB_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
