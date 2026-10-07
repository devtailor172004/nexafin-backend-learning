import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SecurePay Lab backend defaults to http://localhost:3000.
// Using a dev proxy keeps the browser on a single origin, so the backend's
// CORS allow-list does not need to be relaxed for local development.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const target = env.VITE_API_TARGET || 'http://localhost:3000';

    return {
        plugins: [react(), tailwindcss()],
        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target,
                    changeOrigin: true,
                    // SSE must not be buffered.
                    configure: (proxy) => {
                        proxy.on('proxyRes', (proxyRes) => {
                            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
                                proxyRes.headers['cache-control'] = 'no-cache, no-transform';
                            }
                        });
                    }
                }
            }
        },
        build: {
            outDir: 'dist',
            sourcemap: false
        }
    };
});
