import type { ConnectorChainOption, ConnectorTypeGroup, ConnectorTypeInfo } from '../types';

export const GROUP_ORDER: ConnectorTypeGroup[] = ['exchange', 'evm', 'chain', 'app', 'file'];

export const GROUP_LABELS: Record<ConnectorTypeGroup, string> = {
    exchange: 'Exchanges',
    evm: 'EVM (multi-chain)',
    chain: 'Other chains',
    app: 'Apps',
    file: 'Files & brokers',
};

const STATUS_RANK: Record<string, number> = { active: 0, degraded: 1, legacy: 2 };

export interface NetworkOption {
    canonical: string;
    label: string;
}

export function chainOptions(type: ConnectorTypeInfo): ConnectorChainOption[] {
    if (type.chains) return type.chains;
    return (type.supported_chains ?? []).map(c => ({ value: c, canonical: c, label: c.toUpperCase() }));
}

export function supportsChain(type: ConnectorTypeInfo, canonical: string): boolean {
    return chainOptions(type).some(c => c.canonical === canonical);
}

export function chainValueFor(type: ConnectorTypeInfo, canonical: string): string | undefined {
    return chainOptions(type).find(c => c.canonical === canonical)?.value;
}

export function canonicalForValue(type: ConnectorTypeInfo, value?: string | null): string | undefined {
    const options = chainOptions(type);
    if (value) return options.find(c => c.value === value)?.canonical;
    return options.length === 1 ? options[0].canonical : undefined;
}

export function isRecommended(type: ConnectorTypeInfo, canonical?: string | null): boolean {
    return !!canonical && (type.recommended_for ?? []).includes(canonical);
}

export function isDegradedOn(type: ConnectorTypeInfo, canonical?: string | null): boolean {
    if (type.status !== 'degraded') return false;
    const chains = type.degraded_chains ?? [];
    if (!canonical || chains.length === 0) return true;
    return chains.includes(canonical);
}

function rank(type: ConnectorTypeInfo, canonical?: string | null): number {
    if (isRecommended(type, canonical)) return 0;
    if (isDegradedOn(type, canonical)) return 3;
    return 1 + (STATUS_RANK[type.status ?? 'active'] ?? 0);
}

/** Recommended first, then active, degraded, legacy; ties by display name. */
export function sortForChain(types: ConnectorTypeInfo[], canonical?: string | null): ConnectorTypeInfo[] {
    return [...types].sort(
        (a, b) => rank(a, canonical) - rank(b, canonical) || a.display_name.localeCompare(b.display_name),
    );
}

export function filterTypesByChain(types: ConnectorTypeInfo[], canonical?: string | null): ConnectorTypeInfo[] {
    if (!canonical) return types;
    return sortForChain(types.filter(t => supportsChain(t, canonical)), canonical);
}

/** Unique networks across the given types, sorted by label. */
export function listNetworks(types: ConnectorTypeInfo[], only?: Set<string> | null): NetworkOption[] {
    const seen = new Map<string, string>();
    for (const t of types) {
        for (const c of chainOptions(t)) {
            if (only && !only.has(c.canonical)) continue;
            if (!seen.has(c.canonical)) seen.set(c.canonical, c.label);
        }
    }
    return [...seen.entries()]
        .map(([canonical, label]) => ({ canonical, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export function evmNetworks(types: ConnectorTypeInfo[]): Set<string> {
    return new Set(types.filter(t => t.group === 'evm').flatMap(t => chainOptions(t).map(c => c.canonical)));
}

/** Canonical chain for unambiguous address formats, 'evm' for 0x addresses. */
export function detectChainFromAddress(address?: string | null): string | null {
    if (!address) return null;
    if (address.startsWith('0x')) return 'evm';
    if (address.startsWith('r') && address.length >= 25 && address.length <= 35) return 'xrp';
    if (/^[A-Z2-7]{58}$/.test(address)) return 'algorand';
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
    return null;
}

export function formatChainSummary(type: ConnectorTypeInfo, max = 3): string {
    const labels = chainOptions(type).map(c => c.label);
    if (labels.length <= max) return labels.join(', ');
    return `${labels.slice(0, max).join(', ')} +${labels.length - max}`;
}

export function formatTypeOption(type: ConnectorTypeInfo, canonical?: string | null): string {
    let text = type.display_name;
    if (chainOptions(type).length > 1) text += ` — ${formatChainSummary(type)}`;
    const tags: string[] = [];
    if (isRecommended(type, canonical)) tags.push('recommended');
    if (type.status === 'legacy') tags.push('legacy');
    if (isDegradedOn(type, canonical)) tags.push('degraded');
    if (type.missing_env?.length) tags.push(`needs ${type.missing_env.join(', ')}`);
    return tags.length ? `${text} · ${tags.join(' · ')}` : text;
}

export function groupTypes(types: ConnectorTypeInfo[]): { group: ConnectorTypeGroup; label: string; types: ConnectorTypeInfo[] }[] {
    return GROUP_ORDER.map(group => ({
        group,
        label: GROUP_LABELS[group],
        types: types.filter(t => (t.group ?? (t.category === 'onchain' ? 'chain' : 'exchange')) === group),
    })).filter(g => g.types.length > 0);
}

/** Other on-chain providers that support the connector's current chain. */
export function switchCandidates(
    types: ConnectorTypeInfo[],
    current: ConnectorTypeInfo,
    chainValue: string | null | undefined,
    existingTypes: string[],
): ConnectorTypeInfo[] {
    const canonical = canonicalForValue(current, chainValue);
    if (!canonical || current.category !== 'onchain' || current.group === 'app') return [];
    return filterTypesByChain(
        types.filter(
            t => t.category === 'onchain' && t.group !== 'app' && t.type !== current.type && !existingTypes.includes(t.type),
        ),
        canonical,
    );
}
