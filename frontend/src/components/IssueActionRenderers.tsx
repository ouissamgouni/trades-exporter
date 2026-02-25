/**
 * IssueActionRenderers
 * 
 * Reusable action renderer functions for different issue types in Data Health tabs.
 * These can be composed to create custom action columns for each tab.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Input,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import { FiCheck, FiCheckCircle, FiX } from 'react-icons/fi';
import {
    API_URL,
    TransactionIssue,
    Asset,
    Account,
} from '../types';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { toaster } from './ui/toaster';
import { ActionRendererProps } from './UnifiedIssueTransactionTable';
import { linkRawAccount, linkRawAsset } from '../utils/rawAccountApi';

// =============================================================================
// Asset/Account Mapping Renderers
// =============================================================================

/**
 * Renders action for unlinked asset/account issues with suggestions
 * Shows suggestion button (high confidence) or selector (low confidence)
 */
export const LinkageActionRenderer: React.FC<ActionRendererProps> = ({
    issue,
    assets,
    accounts,
    onFixed,
    onAssetsUpdated,
    onAccountsUpdated,
}) => {
    const [isApplying, setIsApplying] = useState(false);

    const isAccountIssue =
        issue.issue_type === 'unlinked_account' ||
        issue.issue_type === 'unlinked_transfer_from_account' ||
        issue.issue_type === 'unlinked_transfer_to_account';

    // API call to map raw asset/account
    const mapRawItem = async (id: number) => {
        if (isAccountIssue) {
            await linkRawAccount({ source: issue.source, label: issue.raw_value, network: issue.network || undefined, accountId: id });
        } else {
            await linkRawAsset({ source: issue.source, symbol: issue.raw_value, network: issue.network || undefined, assetId: id });
        }
    };

    // Handle selector change
    const handleSelect = (id: number | null) => {
        if (!id) return;
        toaster.success({
            title: isAccountIssue ? 'Account mapped' : 'Asset mapped',
            description: `${issue.raw_value} linked successfully`,
        });
        onFixed();
    };

    // Handle suggestion accept
    const handleAcceptSuggestion = async () => {
        if (!issue.suggestion || !issue.raw_value) return;

        setIsApplying(true);
        try {
            await mapRawItem(issue.suggestion.id);
            toaster.success({
                title: isAccountIssue ? 'Account mapped' : 'Asset mapped',
                description: `${issue.raw_value} → ${issue.suggestion.name}`,
            });
            onFixed();
        } catch (err) {
            toaster.error({
                title: 'Failed to apply suggestion',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplying(false);
        }
    };

    const suggestionConfidence = issue.suggestion?.confidence ?? 0;
    const suggestionColor =
        suggestionConfidence >= 0.9 ? 'green' : suggestionConfidence >= 0.7 ? 'blue' : 'gray';

    // Show suggestion button if we have a high-confidence suggestion
    if (issue.suggestion && issue.raw_value) {
        return (
            <Button
                size="xs"
                colorPalette={suggestionColor}
                variant={suggestionConfidence >= 0.9 ? 'solid' : 'outline'}
                onClick={handleAcceptSuggestion}
                disabled={isApplying}
                title={`${Math.round(suggestionConfidence * 100)}% match`}
                h="22px"
                w="full"
            >
                {isApplying ? <Spinner size="xs" /> : <FiCheck size={10} />}
                <Text ml={1} truncate>
                    {issue.suggestion.name}
                </Text>
            </Button>
        );
    }

    // Otherwise show selector
    return (
        <Box w="full">
            {isAccountIssue ? (
                <AccountSelector
                    accounts={accounts}
                    value={null}
                    onChange={handleSelect}
                    onAccountCreated={onAccountsUpdated}
                    size="sm"
                    placeholder="+ Add"
                    defaultName={issue.raw_value}
                    rawAccountLabel={issue.raw_value}
                    rawAccountSource={issue.source}
                    rawAccountNetwork={issue.network || undefined}
                />
            ) : (
                <AssetSelector
                    assets={assets}
                    value={null}
                    onChange={handleSelect}
                    onAssetCreated={onAssetsUpdated}
                    size="sm"
                    placeholder="+ Add"
                    defaultSymbol={issue.raw_value}
                    rawAssetSymbol={issue.raw_value}
                    rawAssetSource={issue.source}
                />
            )}
        </Box>
    );
};

// =============================================================================
// Missing Data Renderers
// =============================================================================

/**
 * Renders action for missing data issues (no raw value, need to set field)
 * Shows selector to set asset/account directly on transaction
 */
export const MissingDataActionRenderer: React.FC<ActionRendererProps> = ({
    issue,
    assets,
    accounts,
    onFixed,
    onAssetsUpdated,
    onAccountsUpdated,
}) => {
    const [isApplying, setIsApplying] = useState(false);

    // Determine if this is an asset or account issue
    const isAssetIssue = issue.issue_type === 'missing_source_asset';
    const isAccountIssue = issue.issue_type === 'missing_source_account';

    // Handle linking asset
    const handleAssetSelect = async (assetId: number | null) => {
        if (!assetId) return;

        setIsApplying(true);
        try {
            const response = await fetch(`${API_URL}/transactions/${issue.transaction_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: assetId }),
            });

            if (!response.ok) throw new Error('Failed to link asset');

            toaster.success({
                title: 'Asset linked',
                description: 'Transaction asset updated successfully',
            });
            onFixed();
        } catch (err) {
            toaster.error({
                title: 'Failed to link asset',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplying(false);
        }
    };

    // Handle linking account
    const handleAccountSelect = async (accountId: number | null) => {
        if (!accountId) return;

        setIsApplying(true);
        try {
            const response = await fetch(`${API_URL}/transactions/${issue.transaction_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_id: accountId }),
            });

            if (!response.ok) throw new Error('Failed to link account');

            toaster.success({
                title: 'Account linked',
                description: 'Transaction account updated successfully',
            });
            onFixed();
        } catch (err) {
            toaster.error({
                title: 'Failed to link account',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplying(false);
        }
    };

    // Handle updating source field
    const handleUpdateSource = async (value: string) => {
        setIsApplying(true);
        try {
            const response = await fetch(`${API_URL}/transactions/${issue.transaction_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: value }),
            });

            if (!response.ok) throw new Error('Failed to update source');

            toaster.success({
                title: 'Source updated',
                description: `Source set to "${value}"`,
            });
            onFixed();
        } catch (err) {
            toaster.error({
                title: 'Failed to update source',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplying(false);
        }
    };

    if (isAssetIssue) {
        return (
            <AssetSelector
                assets={assets}
                value={null}
                onChange={handleAssetSelect}
                onAssetCreated={onAssetsUpdated}
                size="sm"
                placeholder="Select Asset"
                disabled={isApplying}
            />
        );
    }

    if (isAccountIssue) {
        return (
            <AccountSelector
                accounts={accounts}
                value={null}
                onChange={handleAccountSelect}
                onAccountCreated={onAccountsUpdated}
                size="sm"
                placeholder="Select Account"
                disabled={isApplying}
            />
        );
    }

    // For missing_source, show a text input
    return <TextInputAction onSubmit={handleUpdateSource} placeholder="Enter source..." />;
};

// =============================================================================
// Transfer Issue Renderers
// =============================================================================

export interface TransferActionRendererProps extends ActionRendererProps {
    isDismissed?: boolean;
    dismissedReason?: string;
    onDismiss?: (reason: string) => void;
    onUndismiss?: () => void;
}

/**
 * Renders action for transfer issues (missing from/to accounts)
 * Shows account selector, text input mode, and dismiss options
 */
export const TransferActionRenderer: React.FC<TransferActionRendererProps> = ({
    issue,
    accounts,
    onFixed,
    onAccountsUpdated,
    isDismissed,
    dismissedReason,
    onDismiss,
    onUndismiss,
}) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [useTextInput, setUseTextInput] = useState(false);
    const [textValue, setTextValue] = useState('');
    const [showDismissMenu, setShowDismissMenu] = useState(false);

    const fieldName = issue.issue_type.includes('from') ? 'source_from_account' : 'source_to_account';
    const direction = issue.issue_type.includes('from') ? 'From' : 'To';

    // Handle account selector
    const handleAccountSelect = async (accountId: number | null) => {
        if (!accountId) return;

        setIsProcessing(true);
        try {
            const account = accounts.find((a) => a.id === accountId);
            if (!account) return;

            const response = await fetch(
                `${API_URL}/raw-accounts/transfer-source/${issue.transaction_id}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        field: fieldName,
                        value: account.name,
                        account_id: accountId,
                    }),
                }
            );

            if (!response.ok) throw new Error('Failed to update transfer source');

            toaster.success({ title: `${direction} Account linked successfully` });
            onFixed();
        } catch (err) {
            toaster.error({
                title: err instanceof Error ? err.message : 'Failed to update transfer source',
            });
        } finally {
            setIsProcessing(false);
        }
    };

    // Handle text input
    const handleTextSubmit = async () => {
        if (!textValue.trim()) {
            toaster.error({ title: 'Value cannot be empty' });
            return;
        }

        setIsProcessing(true);
        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/transfer-source/${issue.transaction_id}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        field: fieldName,
                        value: textValue.trim(),
                    }),
                }
            );

            if (!response.ok) throw new Error('Failed to update transfer source');

            toaster.success({ title: `${direction} Account set successfully` });
            onFixed();
        } catch (err) {
            toaster.error({
                title: err instanceof Error ? err.message : 'Failed to update transfer source',
            });
        } finally {
            setIsProcessing(false);
        }
    };

    // Handle dismiss
    const handleDismissClick = (reason?: string) => {
        if (onDismiss) {
            onDismiss(reason || '');
            setShowDismissMenu(false);
        }
    };

    if (isDismissed) {
        return (
            <Flex gap={1} align="center">
                <Badge colorPalette="gray" size="xs" variant="outline">
                    Dismissed{dismissedReason ? `: ${dismissedReason}` : ''}
                </Badge>
                {onUndismiss && (
                    <Button size="xs" variant="ghost" onClick={onUndismiss} title="Un-dismiss">
                        ↩️
                    </Button>
                )}
            </Flex>
        );
    }

    if (useTextInput) {
        return (
            <Flex gap={1} align="center">
                <Input
                    size="xs"
                    value={textValue}
                    onChange={(e) => setTextValue(e.target.value)}
                    placeholder="Enter value..."
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTextSubmit();
                        if (e.key === 'Escape') setUseTextInput(false);
                    }}
                    autoFocus
                    disabled={isProcessing}
                />
                <Button
                    size="xs"
                    colorPalette="green"
                    onClick={handleTextSubmit}
                    loading={isProcessing}
                    disabled={!textValue.trim()}
                >
                    <FiCheck size={12} />
                </Button>
                <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                        setUseTextInput(false);
                        setTextValue('');
                    }}
                    disabled={isProcessing}
                >
                    <FiX size={12} />
                </Button>
            </Flex>
        );
    }

    return (
        <Flex gap={1} align="center">
            <Box flex="1">
                <AccountSelector
                    accounts={accounts}
                    value={null}
                    onChange={handleAccountSelect}
                    onAccountCreated={onAccountsUpdated}
                    size="sm"
                    placeholder="Select..."
                    showOwnershipBadge={true}
                    defaultName={issue.raw_value || undefined}
                />
            </Box>
            <Button
                size="xs"
                variant="ghost"
                onClick={() => setUseTextInput(true)}
                title="Enter custom value"
                disabled={isProcessing}
            >
                ✏️
            </Button>
            {onDismiss && (
                <Box position="relative">
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setShowDismissMenu(!showDismissMenu)}
                        title="Dismiss"
                        disabled={isProcessing}
                    >
                        🚫
                    </Button>
                    {showDismissMenu && (
                        <Box
                            position="absolute"
                            top="100%"
                            right={0}
                            mt={1}
                            bg="white"
                            borderWidth={1}
                            borderColor="gray.200"
                            borderRadius="md"
                            boxShadow="lg"
                            p={2}
                            zIndex={10}
                            minW="180px"
                        >
                            <VStack gap={1} align="stretch">
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => handleDismissClick('External Account')}
                                    justifyContent="flex-start"
                                >
                                    External Account
                                </Button>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => handleDismissClick('Not Needed')}
                                    justifyContent="flex-start"
                                >
                                    Not Needed
                                </Button>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => handleDismissClick('Other')}
                                    justifyContent="flex-start"
                                >
                                    Other
                                </Button>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => handleDismissClick()}
                                    justifyContent="flex-start"
                                >
                                    (No Reason)
                                </Button>
                            </VStack>
                        </Box>
                    )}
                </Box>
            )}
        </Flex>
    );
};

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Simple text input with submit/cancel
 */
const TextInputAction: React.FC<{
    onSubmit: (value: string) => Promise<void>;
    placeholder?: string;
}> = ({ onSubmit, placeholder = 'Enter value...' }) => {
    const [value, setValue] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    const handleSubmit = async () => {
        if (!value.trim()) return;

        setIsProcessing(true);
        try {
            await onSubmit(value.trim());
            setValue('');
        } catch (err) {
            // Error already handled by parent
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <Flex gap={1} align="center">
            <Input
                size="xs"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit();
                    if (e.key === 'Escape') setValue('');
                }}
                disabled={isProcessing}
            />
            <Button
                size="xs"
                colorPalette="green"
                onClick={handleSubmit}
                loading={isProcessing}
                disabled={!value.trim()}
            >
                <FiCheck size={12} />
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setValue('')} disabled={isProcessing}>
                <FiX size={12} />
            </Button>
        </Flex>
    );
};
