import { describe, it, expect } from 'vitest';
import type { ConnectorTypeInfo } from '../types';
import {
    detectChainFromAddress,
    evmNetworks,
    filterTypesByChain,
    formatTypeOption,
    groupTypes,
    listNetworks,
    switchCandidates,
} from './connectorTypes';

const chain = (value: string, canonical = value, label = canonical) => ({ value, canonical, label });

const base = { required_config: [], optional_config: [] };

const ankr: ConnectorTypeInfo = {
    ...base,
    type: 'ankr',
    category: 'onchain',
    display_name: 'EVM · Ankr',
    group: 'evm',
    chains: [chain('bsc', 'bsc', 'BNB Smart Chain'), chain('arbitrum', 'arbitrum', 'Arbitrum'), chain('ethereum', 'ethereum', 'Ethereum'), chain('base', 'base', 'Base')],
    recommended_for: ['bsc', 'arbitrum', 'base'],
    status: 'active',
    missing_env: [],
};
const blockscout: ConnectorTypeInfo = {
    ...base,
    type: 'blockscout',
    category: 'onchain',
    display_name: 'EVM · Blockscout',
    group: 'evm',
    chains: [chain('base', 'base', 'Base'), chain('ethereum', 'ethereum', 'Ethereum')],
    status: 'degraded',
    degraded_chains: ['base'],
};
const etherscan: ConnectorTypeInfo = {
    ...base,
    type: 'etherscan',
    category: 'onchain',
    display_name: 'EVM · Etherscan',
    group: 'evm',
    chains: [chain('ethereum', 'ethereum', 'Ethereum')],
    recommended_for: ['ethereum'],
    status: 'active',
};
const moralis: ConnectorTypeInfo = {
    ...base,
    type: 'moralis',
    category: 'onchain',
    display_name: 'EVM · Moralis (legacy)',
    group: 'evm',
    chains: [chain('eth', 'ethereum', 'Ethereum'), chain('bsc', 'bsc', 'BNB Smart Chain')],
    status: 'legacy',
    missing_env: ['MORALIS_API_KEY'],
};
const sui: ConnectorTypeInfo = {
    ...base,
    type: 'sui',
    category: 'onchain',
    display_name: 'Sui (GraphQL)',
    group: 'chain',
    chains: [chain('sui', 'sui', 'SUI')],
    recommended_for: ['sui'],
};
const polymarket: ConnectorTypeInfo = {
    ...base,
    type: 'polymarket',
    category: 'onchain',
    display_name: 'Polymarket',
    group: 'app',
    chains: [chain('polygon', 'polygon', 'Polygon')],
};
const binance: ConnectorTypeInfo = {
    ...base,
    type: 'binance-transactions',
    category: 'cex',
    display_name: 'Binance Transactions',
    group: 'exchange',
};

const all = [binance, moralis, blockscout, etherscan, ankr, sui, polymarket];

describe('connectorTypes (major)', () => {
    it('filters by chain with the recommended provider first and legacy last', () => {
        expect(filterTypesByChain(all, 'bsc').map(t => t.type)).toEqual(['ankr', 'moralis']);
        expect(filterTypesByChain(all, 'ethereum').map(t => t.type)).toEqual(['etherscan', 'ankr', 'blockscout', 'moralis']);
    });

    it('ranks a provider degraded on the chosen chain below active ones', () => {
        expect(filterTypesByChain(all, 'base').map(t => t.type)).toEqual(['ankr', 'blockscout']);
    });

    it('matches Moralis "eth" through its canonical chain', () => {
        expect(filterTypesByChain(all, 'ethereum')).toContain(moralis);
    });

    it('returns all types when no chain is selected', () => {
        expect(filterTypesByChain(all, null)).toBe(all);
    });

    it('lists unique networks, optionally limited to EVM chains', () => {
        const networks = listNetworks(all).map(n => n.canonical);
        expect(networks).toEqual(['arbitrum', 'base', 'bsc', 'ethereum', 'polygon', 'sui']);
        expect(listNetworks(all, evmNetworks(all)).map(n => n.canonical)).not.toContain('sui');
    });

    it('formats options with chain summary and tags', () => {
        expect(formatTypeOption(ankr, 'bsc')).toBe('EVM · Ankr — BNB Smart Chain, Arbitrum, Ethereum +1 · recommended');
        expect(formatTypeOption(moralis)).toBe('EVM · Moralis (legacy) — Ethereum, BNB Smart Chain · legacy · needs MORALIS_API_KEY');
        expect(formatTypeOption(blockscout, 'ethereum')).toBe('EVM · Blockscout — Base, Ethereum');
        expect(formatTypeOption(blockscout, 'base')).toContain('degraded');
        expect(formatTypeOption(sui)).toBe('Sui (GraphQL)');
    });

    it('groups types in a fixed order', () => {
        expect(groupTypes(all).map(g => g.group)).toEqual(['exchange', 'evm', 'chain', 'app']);
    });

    it('detects address families', () => {
        expect(detectChainFromAddress('0xabc')).toBe('evm');
        expect(detectChainFromAddress('rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH')).toBe('xrp');
        expect(detectChainFromAddress('5SNZVDHT7UJPJ2HOFGWO5L3GMV4YFVDDWBLPQY6OLRPANPHRPJWFMXH7DI')).toBe('algorand');
        expect(detectChainFromAddress('playwright_e2e_wallet')).toBeNull();
    });

    it('offers switch candidates on the same chain, excluding apps and existing types', () => {
        expect(switchCandidates(all, moralis, 'eth', ['moralis']).map(t => t.type)).toEqual(['etherscan', 'ankr', 'blockscout']);
        expect(switchCandidates(all, moralis, 'eth', ['moralis', 'etherscan']).map(t => t.type)).toEqual(['ankr', 'blockscout']);
        expect(switchCandidates(all, polymarket, 'polygon', [])).toEqual([]);
        expect(switchCandidates(all, binance, null, [])).toEqual([]);
    });
});
