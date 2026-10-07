/**
 * Payment provider capability registry.
 *
 * Declares what each provider can actually do. The health endpoint and the
 * future Smart Router both read from here, so adding a provider is a one-file
 * change rather than a new integration path per payment method.
 *
 * `integrated: false` entries are placeholders that make the routing model
 * explicit without pretending a live integration exists.
 */

export const PAYMENT_PROVIDERS = Object.freeze({
    PINELABS: {
        code: 'PINELABS',
        displayName: 'Pine Labs Plural',
        integrated: true,
        enabled: true,
        methods: ['UPI', 'CARD', 'NETBANKING'],
        countries: ['IN'],
        currencies: ['INR'],
        supportsRefunds: true,
        supportsPayouts: false,
        supportsPreAuth: true
    },
    INTERNAL_MOCK: {
        code: 'INTERNAL_MOCK',
        displayName: 'Internal Mock Provider',
        integrated: true,
        enabled: false,
        methods: ['CARD'],
        countries: ['US', 'GB', 'AE', 'SG'],
        currencies: ['USD', 'GBP', 'AED', 'SGD'],
        supportsRefunds: true,
        supportsPayouts: false,
        supportsPreAuth: false
    }
});

export const listProviders = () => Object.values(PAYMENT_PROVIDERS);

export const getProvider = (code) => PAYMENT_PROVIDERS[String(code || '').toUpperCase()] || null;

export const listMethods = () => {
    const methods = new Set();
    listProviders().forEach((p) => p.methods.forEach((m) => methods.add(m)));
    return [...methods];
};

export const listCurrencies = () => {
    const currencies = new Set();
    listProviders().forEach((p) => p.currencies.forEach((c) => currencies.add(c)));
    return [...currencies];
};

/**
 * Returns providers that could serve the given requirement.
 * This is the selection primitive the Smart Router will build on.
 */
export const findEligibleProviders = ({ method, currency, country } = {}) => (
    listProviders().filter((provider) => {
        if (!provider.integrated || !provider.enabled) return false;
        if (method && !provider.methods.includes(String(method).toUpperCase())) return false;
        if (currency && !provider.currencies.includes(String(currency).toUpperCase())) return false;
        if (country && !provider.countries.includes(String(country).toUpperCase())) return false;
        return true;
    })
);

export default PAYMENT_PROVIDERS;
