import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ValidationSummary } from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface DataHealthContextType {
    validationSummary: ValidationSummary | null;
    refreshHealthData: (accountIds?: number[], options?: { includeDismissed?: boolean }) => Promise<void>;
    isLoading: boolean;
    showDismissedMappings: boolean;
    setShowDismissedMappings: (show: boolean) => void;
}

const DataHealthContext = createContext<DataHealthContextType | undefined>(undefined);

export const DataHealthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [showDismissedMappings, setShowDismissedMappings] = useState(false);

    const refreshHealthData = useCallback(async (accountIds?: number[], options?: { includeDismissed?: boolean }) => {
        setIsLoading(true);
        try {
            let url = `${API_URL}/transactions/data-health-check/status`;
            const params = new URLSearchParams();
            
            if (accountIds && accountIds.length > 0) {
                params.append('account_ids', accountIds.join(','));
            }
            
            if (options?.includeDismissed !== undefined) {
                params.append('include_dismissed', options.includeDismissed.toString());
            }
            
            if (params.toString()) {
                url += `?${params}`;
            }
            
            const response = await fetch(url);
            if (response.ok) {
                const data: ValidationSummary = await response.json();
                setValidationSummary(data);
            } else {
                // Show healthy state on error
                setValidationSummary({
                    total_count: 0,
                    valid_count: 0,
                    pending_count: 0,
                    invalid_count: 0,
                    bundle_suggestions_count: 0,
                    linkage_issues_count: 0,
                    transfer_issues_count: 0,
                    duplicate_count: 0,
                    has_issues: false,
                    total_issues: 0,
                });
            }
        } catch (err) {
            console.error('Failed to fetch validation summary:', err);
            // Show healthy state on error
            setValidationSummary({
                total_count: 0,
                valid_count: 0,
                pending_count: 0,
                invalid_count: 0,
                bundle_suggestions_count: 0,
                linkage_issues_count: 0,
                transfer_issues_count: 0,
                duplicate_count: 0,
                has_issues: false,
                total_issues: 0,
            });
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Initial fetch and polling
    useEffect(() => {
        refreshHealthData();
        // Refresh every 30 seconds
        const interval = setInterval(() => refreshHealthData(), 30000);
        return () => clearInterval(interval);
    }, [refreshHealthData]);

    return (
        <DataHealthContext.Provider value={{ validationSummary, refreshHealthData, isLoading, showDismissedMappings, setShowDismissedMappings }}>
            {children}
        </DataHealthContext.Provider>
    );
};

export const useDataHealth = () => {
    const context = useContext(DataHealthContext);
    if (context === undefined) {
        throw new Error('useDataHealth must be used within a DataHealthProvider');
    }
    return context;
};
