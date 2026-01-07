/**
 * Fuzzy matching utility for smart suggestions
 * Used for suggesting similar accounts/assets based on string similarity
 */

/**
 * Calculate Levenshtein distance between two strings
 */
export const levenshteinDistance = (str1: string, str2: string): number => {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
};

/**
 * Calculate similarity between two strings (0 to 1)
 * Uses multiple heuristics: exact match, contains, starts with, and Levenshtein
 */
export const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Exact match
    if (s1 === s2) return 1.0;

    // Contains match (e.g., "BTCUSDT" contains "BTC")
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Starts with match
    if (s1.startsWith(s2) || s2.startsWith(s1)) return 0.7;

    // Levenshtein-based similarity for short strings
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;

    const distance = levenshteinDistance(s1, s2);
    return 1 - (distance / maxLen);
};

/**
 * Suggestion match with confidence score
 */
export interface SuggestedMatch<T> {
    item: T;
    confidence: number;
}

/**
 * Get account suggestions based on source account label
 */
export const getAccountSuggestions = <T extends { name: string; address_or_identifier?: string | null }>(
    sourceLabel: string,
    accounts: T[],
    minConfidence: number = 0.5,
    maxSuggestions: number = 3
): SuggestedMatch<T>[] => {
    if (!sourceLabel) return [];

    const suggestions: SuggestedMatch<T>[] = [];

    for (const account of accounts) {
        // Compare against account name AND address
        const nameSim = calculateSimilarity(sourceLabel, account.name);
        const addrSim = account.address_or_identifier
            ? calculateSimilarity(sourceLabel, account.address_or_identifier)
            : 0;
        const confidence = Math.max(nameSim, addrSim);

        if (confidence >= minConfidence) {
            suggestions.push({ item: account, confidence });
        }
    }

    return suggestions
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxSuggestions);
};

/**
 * Get asset suggestions based on source symbol
 */
export const getAssetSuggestions = <T extends { symbol: string; label?: string | null }>(
    sourceSymbol: string,
    assets: T[],
    minConfidence: number = 0.5,
    maxSuggestions: number = 3
): SuggestedMatch<T>[] => {
    if (!sourceSymbol) return [];

    const suggestions: SuggestedMatch<T>[] = [];

    for (const asset of assets) {
        // Compare against asset symbol AND label
        const symbolSim = calculateSimilarity(sourceSymbol, asset.symbol);
        const labelSim = asset.label
            ? calculateSimilarity(sourceSymbol, asset.label)
            : 0;
        const confidence = Math.max(symbolSim, labelSim);

        if (confidence >= minConfidence) {
            suggestions.push({ item: asset, confidence });
        }
    }

    return suggestions
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxSuggestions);
};

/**
 * Get confidence badge color based on confidence level
 */
export const getConfidenceColor = (confidence: number): string => {
    if (confidence >= 0.9) return 'green';
    if (confidence >= 0.7) return 'blue';
    return 'gray';
};

/**
 * Format confidence as percentage string
 */
export const formatConfidence = (confidence: number): string => {
    return `${Math.round(confidence * 100)}%`;
};
