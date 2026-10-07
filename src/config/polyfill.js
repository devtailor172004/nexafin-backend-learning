import crypto from 'crypto';

try {
    const webCrypto = crypto.webcrypto;
    
    if (webCrypto && webCrypto.getRandomValues) {
        // If Node has webcrypto built-in, use it
        if (typeof globalThis.crypto === 'undefined') {
            Object.defineProperty(globalThis, 'crypto', {
                value: webCrypto,
                configurable: true,
                writable: true
            });
        } else if (typeof globalThis.crypto.getRandomValues === 'undefined') {
            try {
                globalThis.crypto.getRandomValues = webCrypto.getRandomValues.bind(webCrypto);
            } catch (err) {
                Object.defineProperty(globalThis.crypto, 'getRandomValues', {
                    value: webCrypto.getRandomValues.bind(webCrypto),
                    configurable: true,
                    writable: true
                });
            }
        }
    } else {
        // Fallback for older Node versions using randomFillSync
        const fallbackGetRandomValues = (arr) => crypto.randomFillSync(arr);
        
        if (typeof globalThis.crypto === 'undefined') {
            Object.defineProperty(globalThis, 'crypto', {
                value: { getRandomValues: fallbackGetRandomValues },
                configurable: true,
                writable: true
            });
        } else if (typeof globalThis.crypto.getRandomValues === 'undefined') {
            try {
                globalThis.crypto.getRandomValues = fallbackGetRandomValues;
            } catch (err) {
                Object.defineProperty(globalThis.crypto, 'getRandomValues', {
                    value: fallbackGetRandomValues,
                    configurable: true,
                    writable: true
                });
            }
        }
    }
} catch (err) {
    import('../utils/logger.js').then((loggerModule) => {
        loggerModule.default.error("Web Crypto polyfill error:", err);
    }).catch(() => {
        console.error("Web Crypto polyfill error:", err);
    });
}
