// Isolated, browser-only design artifact. No Backend proxy or production configuration access.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
const requireFrontend = createRequire(resolve(repo, 'frontend/package.json'));
const { createServer, build } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
const packages = ['react', 'react-dom', '@tabler/icons-react', '@radix-ui/react-popover', '@radix-ui/react-dialog', 'cmdk'];
const alias = packages.map(name => ({ find: name, replacement: resolve(repo, 'frontend/node_modules', name) }));
const config = {
  configFile: false, root, cacheDir: resolve(repo, '.data/design-previews/workflow-settings/vite'),
  resolve: { alias }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 43118, strictPort: true, fs: { allow: [root, resolve(repo, 'node_modules'), resolve(repo, 'frontend')] } },
};
if (process.argv.includes('--build')) {
  await build({ ...config, build: { outDir: resolve(repo, '.data/design-previews/workflow-settings/build'), emptyOutDir: true } });
} else {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
}
