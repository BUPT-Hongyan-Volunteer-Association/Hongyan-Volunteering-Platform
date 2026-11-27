import basicSsl from '@vitejs/plugin-basic-ssl';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type ProxyOptions } from 'vite';

export function apiProxy(target: string): Record<string, ProxyOptions> {
  return {
    '/api/v1': {
      target,
      configure(proxy) {
        proxy.on('proxyRes', (upstream, _request, downstream) => {
          if (upstream.headers['content-type']?.startsWith('text/event-stream')) {
            // An HTTP/2 reset can mark the downstream finished while the SSE producer is still listening.
            downstream.once('close', () => { if (!upstream.complete) upstream.destroy(); });
          }
        });
      },
    },
  };
}

export function frontend(port: number) {
  return defineConfig({
    plugins: [vue(), process.env.HY_LOCAL_HTTPS === '1' && basicSsl()],
    server: {
      host: 'localhost',
      port,
      strictPort: true,
      proxy: apiProxy('http://127.0.0.1:3000'),
    },
  });
}
