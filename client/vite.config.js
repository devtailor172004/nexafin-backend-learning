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
                    configure: (proxy) => {
                        /*
                         * The backend enforces a CORS allow-list (CORS_ORIGINS).
                         * A browser sends `Origin: http://localhost:5173` and the
                         * proxy would forward it verbatim, so the backend would
                         * treat a same-origin dev request as cross-origin and
                         * reject it with "CORS blocked".
                         *
                         * Stripping Origin/Referer makes the proxied call look like
                         * the server-to-server request it actually is. This only
                         * affects local development; a deployed frontend on another
                         * origin still needs to be listed in CORS_ORIGINS.
                         */
                        proxy.on('proxyReq', (proxyReq) => {
                            proxyReq.removeHeader('origin');
                            proxyReq.removeHeader('referer');
                        });

                        // SSE must not be buffered.
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
