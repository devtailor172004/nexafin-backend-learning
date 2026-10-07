// CommonJS wrapper to load ES Module index.js under Phusion Passenger on cPanel
(async () => {
    await import('./index.js');
})();
