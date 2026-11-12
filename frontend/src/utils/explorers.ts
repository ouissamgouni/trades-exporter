const EXPLORERS: Record<string, { base: string; tokenPath: string }> = {
    ethereum: { base: 'https://etherscan.io', tokenPath: 'token' },
    base: { base: 'https://basescan.org', tokenPath: 'token' },
    arbitrum: { base: 'https://arbiscan.io', tokenPath: 'token' },
    optimism: { base: 'https://optimistic.etherscan.io', tokenPath: 'token' },
    polygon: { base: 'https://polygonscan.com', tokenPath: 'token' },
    bsc: { base: 'https://bscscan.com', tokenPath: 'token' },
    avalanche: { base: 'https://snowtrace.io', tokenPath: 'token' },
    hyperevm: { base: 'https://hyperevmscan.io', tokenPath: 'token' },
    solana: { base: 'https://solscan.io', tokenPath: 'token' },
    sui: { base: 'https://suiscan.xyz/mainnet', tokenPath: 'coin' },
    near: { base: 'https://nearblocks.io', tokenPath: 'token' },
    cardano: { base: 'https://cardanoscan.io', tokenPath: 'token' },
    algorand: { base: 'https://allo.info', tokenPath: 'asset' },
};

export function tokenExplorerUrl(network: string | null | undefined, address: string): string | null {
    const e = EXPLORERS[(network ?? '').toLowerCase()];
    return e ? `${e.base}/${e.tokenPath}/${encodeURIComponent(address)}` : null;
}
