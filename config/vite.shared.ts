import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export function frontend(port: number) {
  return defineConfig({
    plugins: [vue()],
    server: {
      host: 'localhost',
      port,
      strictPort: true,
      proxy: { '/api/v1': 'http://127.0.0.1:3000' },
    },
  });
}
