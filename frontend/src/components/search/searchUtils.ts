export type SearchScope = 'all' | 'assets' | 'accounts' | 'transactions';

export interface ParsedQuery {
    scope: SearchScope;
    text: string;
    txId: number | null;
}

const PREFIXES: [string, SearchScope][] = [
    ['acc:', 'accounts'],
    ['a:', 'assets'],
    ['tx:', 'transactions'],
];

/** Splits an optional scope prefix (`a:`, `acc:`, `tx:`) and detects a transaction id (`#123` / `123`). */
export function parseQuery(raw: string): ParsedQuery {
    let text = raw.trim();
    let scope: SearchScope = 'all';
    const lower = text.toLowerCase();
    for (const [prefix, s] of PREFIXES) {
        if (lower.startsWith(prefix)) {
            scope = s;
            text = text.slice(prefix.length).trim();
            break;
        }
    }
    const idMatch = /^#?(\d{1,10})$/.exec(text);
    const txId = idMatch && (scope === 'all' || scope === 'transactions') ? Number(idMatch[1]) || null : null;
    return { scope, text, txId };
}

/**
 * Lower is better; null = no match. Exact beats starts-with beats word-start beats contains,
 * and earlier fields (e.g. symbol) beat later ones (e.g. address) at the same tier.
 */
export function matchScore(query: string, fields: (string | null | undefined)[]): number | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    let best: number | null = null;
    fields.forEach((field, i) => {
        if (!field) return;
        const f = field.toLowerCase();
        let tier: number | null = null;
        if (f === q) tier = 0;
        else if (f.startsWith(q)) tier = 1;
        else if (f.split(/[\s\-_/.()]+/).some(w => w.startsWith(q))) tier = 2;
        else if (f.includes(q)) tier = 3;
        if (tier == null) return;
        const score = tier * 100 + i;
        if (best == null || score < best) best = score;
    });
    return best;
}

/** Items matching `query`, best first (ties: shorter primary text, then alphabetical). */
export function rankItems<T>(
    items: T[],
    query: string,
    fields: (item: T) => (string | null | undefined)[],
    limit: number,
): T[] {
    const scored: { item: T; score: number; key: string }[] = [];
    for (const item of items) {
        const f = fields(item);
        const score = matchScore(query, f);
        if (score != null) scored.push({ item, score, key: (f[0] ?? '').toLowerCase() });
    }
    scored.sort((a, b) => a.score - b.score || a.key.length - b.key.length || a.key.localeCompare(b.key));
    return scored.slice(0, limit).map(s => s.item);
}
