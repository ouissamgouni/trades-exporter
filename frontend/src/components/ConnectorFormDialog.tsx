import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useState, useEffect } from 'react';
import { Badge, Button, Input, Textarea } from './ui/primitives';
import { Account, AccountConnector, ConnectorTypeInfo, API_URL } from '../types';
import { ColorPaletteField } from './ColorPaletteField';
import { getNextAvailableEntityColor } from '../hooks/useEntityColors';
import {
    canonicalForValue,
    chainOptions,
    chainValueFor,
    detectChainFromAddress,
    evmNetworks,
    filterTypesByChain,
    formatTypeOption,
    groupTypes,
    isDegradedOn,
    isRecommended,
    listNetworks,
    switchCandidates,
} from '../utils/connectorTypes';

const chipClass = (type: ConnectorTypeInfo, canonical: string, active: string | null): string => {
    if (canonical === active) return 'border-blue-400 bg-blue-50 text-blue-700';
    if (type.degraded_chains?.length && isDegradedOn(type, canonical)) return 'border-amber-300 bg-amber-50 text-amber-700';
    if (isRecommended(type, canonical)) return 'border-green-300 bg-green-50 text-green-700';
    return 'border-slate-200 bg-white text-slate-600';
};

interface ConnectorFormDialogProps {
    isOpen: boolean;
    onClose: () => void;
    account: Account;
    connector?: AccountConnector | null;
    connectorTypes: ConnectorTypeInfo[];
    existingConnectorTypes: string[];
    /** Colors already assigned to sibling connectors (for dedup hints) */
    usedColors?: string[];
}

const ConnectorFormDialog: React.FC<ConnectorFormDialogProps> = ({
    isOpen,
    onClose,
    account,
    connector,
    connectorTypes,
    existingConnectorTypes,
    usedColors = [],
}) => {
    const [formData, setFormData] = useState({
        connector_type: '',
        enabled: true,
        config: {} as Record<string, any>,
        credentials_ref: '',
        sync_priority: 100,
        color: null as string | null,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [defaultFile, setDefaultFile] = useState<File | null>(null);
    const [defaultFileName, setDefaultFileName] = useState<string | null>(null);
    const [uploadingDefault, setUploadingDefault] = useState(false);

    // Test fixture state
    const [testFixtureFile, setTestFixtureFile] = useState<File | null>(null);
    const [testFixtureStatus, setTestFixtureStatus] = useState<{
        test_mode: boolean;
        has_fixture: boolean;
        item_count: number | null;
    } | null>(null);
    const [uploadingFixture, setUploadingFixture] = useState(false);

    // Network filter (canonical chain, '' = all) for wallet accounts
    const [networkFilter, setNetworkFilter] = useState('');
    const [switchOpen, setSwitchOpen] = useState(false);
    const [switchTarget, setSwitchTarget] = useState('');
    const [switching, setSwitching] = useState(false);

    // Track previous isOpen state to detect when dialog opens
    const prevIsOpenRef = React.useRef(isOpen);

    // Get available types for new connectors (not already configured)
    const availableTypes = connector
        ? connectorTypes // If editing, show all types
        : connectorTypes.filter(t => !existingConnectorTypes.includes(t.type));

    const selectedTypeInfo = connectorTypes.find(t => t.type === formData.connector_type);

    const isWalletAccount = account.account_type === 'wallet';
    const addressFamily = isWalletAccount ? detectChainFromAddress(account.address_or_identifier) : null;
    const networkOptions = listNetworks(
        availableTypes.filter(t => t.category === 'onchain'),
        addressFamily === 'evm' ? evmNetworks(connectorTypes) : null,
    );
    const visibleTypes = filterTypesByChain(availableTypes, networkFilter || null);
    const swapCandidates = connector && selectedTypeInfo
        ? switchCandidates(connectorTypes, selectedTypeInfo, connector.config?.chain, existingConnectorTypes)
        : [];

    useEffect(() => {
        // Only reset form when dialog opens (not on every render)
        const dialogJustOpened = isOpen && !prevIsOpenRef.current;
        prevIsOpenRef.current = isOpen;

        if (!dialogJustOpened) {
            return;
        }

        if (connector) {
            setFormData({
                connector_type: connector.connector_type,
                enabled: connector.enabled,
                config: connector.config || {},
                credentials_ref: connector.credentials_ref || '',
                sync_priority: connector.sync_priority,
                color: connector.color || null,
            });
            // Load default file name if set
            setDefaultFileName(connector.config?.default_file_name || null);
            setDefaultFile(null);

            // Load test fixture status
            setTestFixtureFile(null);
            if (connector.id) {
                fetch(`${API_URL}/fixtures/connectors/${connector.id}/test-fixture`)
                    .then(r => r.ok ? r.json() : null)
                    .then(data => setTestFixtureStatus(data))
                    .catch(() => setTestFixtureStatus(null));
            }
        } else {
            // Reset form for creating new connector
            const remaining = connectorTypes.filter(t => !existingConnectorTypes.includes(t.type));
            // Unambiguous address formats (XRP, Solana) pre-select their network
            const detected = account.account_type === 'wallet'
                ? detectChainFromAddress(account.address_or_identifier)
                : null;
            const initialNetwork = detected && detected !== 'evm' && remaining.some(t => chainValueFor(t, detected))
                ? detected
                : '';
            const firstAvailable = initialNetwork ? filterTypesByChain(remaining, initialNetwork)[0] : remaining[0];

            const initialConfig: Record<string, any> = {};
            const initialChain = initialNetwork && firstAvailable ? chainValueFor(firstAvailable, initialNetwork) : undefined;
            if (initialChain) {
                initialConfig.chain = initialChain;
            }
            setNetworkFilter(initialNetwork);

            setFormData({
                connector_type: firstAvailable?.type || '',
                enabled: true,
                config: initialConfig,
                credentials_ref: '',
                sync_priority: 100,
                color: getNextAvailableEntityColor(usedColors),
            });
            setTestFixtureStatus(null);
            setTestFixtureFile(null);
        }
        setError('');
        setSwitchOpen(false);
        setSwitchTarget('');
    }, [isOpen, connector, connectorTypes, existingConnectorTypes, account]);

    const handleNetworkChange = (canonical: string) => {
        setNetworkFilter(canonical);
        if (!canonical) return;
        const type = filterTypesByChain(availableTypes, canonical)[0];
        const chain = type ? chainValueFor(type, canonical) : undefined;
        setFormData(prev => ({
            ...prev,
            connector_type: type?.type ?? '',
            config: chain ? { chain } : {},
        }));
    };

    const handleTypeChange = (typeKey: string) => {
        const type = connectorTypes.find(t => t.type === typeKey);
        const chain = type && networkFilter ? chainValueFor(type, networkFilter) : undefined;
        setFormData(prev => ({
            ...prev,
            connector_type: typeKey,
            config: chain ? { chain } : {}, // Reset config when type changes
        }));
    };

    const handleSwitchProvider = async () => {
        if (!connector || !switchTarget) return;
        setSwitching(true);
        setError('');
        try {
            const response = await fetch(
                `${API_URL}/accounts/${account.id}/connectors/${connector.connector_type}/switch`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_connector_type: switchTarget }),
                }
            );
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to switch provider');
            }
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to switch provider');
        } finally {
            setSwitching(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const configToSave = { ...formData.config };

            // Remove address from config if it's inherited from account
            // (Backend will auto-inherit it)
            const isWalletAccount = account.account_type === 'wallet';
            const shouldInheritAddress = isWalletAccount && account.address_or_identifier;
            if (shouldInheritAddress && configToSave.address === account.address_or_identifier) {
                delete configToSave.address;
            }

            const payload = {
                connector_type: formData.connector_type,
                enabled: formData.enabled,
                config: configToSave,
                credentials_ref: formData.credentials_ref || null,
                sync_priority: formData.sync_priority,
                color: formData.color || null,
            };

            const url = connector
                ? `${API_URL}/accounts/${account.id}/connectors/${connector.connector_type}`
                : `${API_URL}/accounts/${account.id}/connectors/`;

            const method = connector ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to save connector');
            }

            const savedConnector = await response.json();

            // Upload default file for file connectors if a file was selected
            if (defaultFile && savedConnector.id) {
                setUploadingDefault(true);
                const fileFormData = new FormData();
                fileFormData.append('file', defaultFile);

                const uploadResponse = await fetch(
                    `${API_URL}/connectors/${savedConnector.id}/upload-file/confirm?as_default=true`,
                    {
                        method: 'POST',
                        body: fileFormData,
                    }
                );

                if (!uploadResponse.ok) {
                    const errorData = await uploadResponse.json();
                    throw new Error(errorData.detail || 'Failed to upload default file');
                }
            }

            onClose();
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
            setUploadingDefault(false);
        }
    };

    const updateConfig = (key: string, value: any) => {
        setFormData(prev => ({
            ...prev,
            config: { ...prev.config, [key]: value },
        }));
    };

    const handleUploadFixture = async () => {
        if (!testFixtureFile || !connector?.id) return;
        setUploadingFixture(true);
        setError('');
        try {
            const fd = new FormData();
            fd.append('file', testFixtureFile);
            const response = await fetch(
                `${API_URL}/fixtures/connectors/${connector.id}/test-fixture`,
                { method: 'POST', body: fd }
            );
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Failed to upload fixture');
            }
            const result = await response.json();
            setTestFixtureStatus({ test_mode: true, has_fixture: true, item_count: result.item_count });
            setTestFixtureFile(null);
        } catch (err: any) {
            setError(err.message || 'Failed to upload fixture');
        } finally {
            setUploadingFixture(false);
        }
    };

    const handleRemoveFixture = async () => {
        if (!connector?.id) return;
        setUploadingFixture(true);
        setError('');
        try {
            const response = await fetch(
                `${API_URL}/fixtures/connectors/${connector.id}/test-fixture`,
                { method: 'DELETE' }
            );
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Failed to remove fixture');
            }
            setTestFixtureStatus({ test_mode: false, has_fixture: false, item_count: null });
            setTestFixtureFile(null);
        } catch (err: any) {
            setError(err.message || 'Failed to remove fixture');
        } finally {
            setUploadingFixture(false);
        }
    };

    const renderTypeDetails = (type: ConnectorTypeInfo) => {
        const chains = chainOptions(type);
        const activeCanonical = networkFilter || canonicalForValue(type, formData.config.chain) || null;
        const statusNote = type.status && type.status !== 'active' ? type.status_note : null;
        const missingEnv = type.missing_env ?? [];
        if (chains.length === 0 && !statusNote && missingEnv.length === 0) return null;

        return (
            <div className="mt-2 flex flex-col gap-1.5" data-testid="connector-type-details">
                {chains.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {chains.map(c => (
                            <span
                                key={c.value}
                                title={
                                    isRecommended(type, c.canonical)
                                        ? 'Recommended for this chain'
                                        : type.degraded_chains?.includes(c.canonical)
                                            ? 'Degraded on this chain'
                                            : undefined
                                }
                                className={`border px-1.5 py-0.5 text-[10px] ${chipClass(type, c.canonical, activeCanonical)}`}
                            >
                                {c.label}
                            </span>
                        ))}
                    </div>
                )}
                {statusNote && (
                    <span className={`block text-xs ${type.status === 'legacy' ? 'text-slate-500' : 'text-amber-700'}`}>
                        {type.status === 'legacy' ? 'Legacy' : 'Degraded'}: {statusNote}
                    </span>
                )}
                {missingEnv.length > 0 && (
                    <span className="block bg-red-50 px-2 py-1 text-xs text-red-700">
                        Not set on the server: {missingEnv.join(', ')}
                    </span>
                )}
            </div>
        );
    };

    const renderSwitchProvider = () => {
        if (!switchOpen) {
            return (
                <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => {
                        setSwitchOpen(true);
                        setSwitchTarget(swapCandidates[0]?.type ?? '');
                    }}
                >
                    Switch provider
                </Button>
            );
        }
        const canonical = selectedTypeInfo ? canonicalForValue(selectedTypeInfo, connector?.config?.chain) : undefined;

        return (
            <div className="mt-2 flex flex-col gap-2 border border-slate-200 bg-slate-50 p-3" data-testid="switch-provider">
                {swapCandidates.length === 0 ? (
                    <span className="text-xs text-slate-500">No other provider supports this chain.</span>
                ) : (
                    <>
                        <select
                            aria-label="New provider"
                            value={switchTarget}
                            onChange={(e) => setSwitchTarget(e.target.value)}
                            className="h-9 w-full border border-slate-200 bg-white px-2 text-sm"
                        >
                            {swapCandidates.map(t => (
                                <option key={t.type} value={t.type}>
                                    {formatTypeOption(t, canonical)}
                                </option>
                            ))}
                        </select>
                        <span className="text-xs text-slate-500">
                            Keeps this connector's ID, history and settings; only future syncs use the new
                            provider. Unsaved edits in this dialog are discarded.
                        </span>
                    </>
                )}
                <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSwitchOpen(false)} disabled={switching}>
                        Cancel
                    </Button>
                    {swapCandidates.length > 0 && (
                        <Button
                            size="sm"
                            colorScheme="blue"
                            onClick={handleSwitchProvider}
                            loading={switching}
                            disabled={!switchTarget}
                        >
                            Switch
                        </Button>
                    )}
                </div>
            </div>
        );
    };

    const renderConfigFields = () => {
        if (!selectedTypeInfo) return null;

        const fields = [];

        const accountAddress = account.address_or_identifier;
        const detectedChain = addressFamily && addressFamily !== 'evm'
            ? chainValueFor(selectedTypeInfo, addressFamily) ?? null
            : null;
        const shouldInheritAddress = !!(isWalletAccount && accountAddress);

        // Chain selector for on-chain connectors
        if (selectedTypeInfo.supported_chains?.length) {
            // Priority: 1) user selection in form, 2) saved connector config (immediate prop),
            // 3) auto-detected from address, 4) empty
            const chainValue = formData.config.chain || connector?.config?.chain || detectedChain || '';
            // Only lock chain for unambiguous address formats (XRP, Solana)
            const isChainInherited = !!detectedChain;

            fields.push(
                <div key="chain">
                    <span className="mb-1 block font-medium">
                        Chain <span className="text-red-500">*</span>
                    </span>
                    <select
                        aria-label="Chain"
                        disabled={isChainInherited}
                        value={chainValue}
                        onChange={(e) => {
                            updateConfig('chain', e.target.value);
                            if (networkFilter) {
                                setNetworkFilter(canonicalForValue(selectedTypeInfo, e.target.value) ?? '');
                            }
                        }}
                        className="h-9 w-full border border-slate-200 bg-white px-2 text-sm disabled:opacity-50"
                    >
                        <option value="">Select chain...</option>
                        {chainOptions(selectedTypeInfo).map(c => (
                            <option key={c.value} value={c.value}>
                                {c.label}
                                {selectedTypeInfo.degraded_chains?.includes(c.canonical) ? ' (degraded)' : ''}
                            </option>
                        ))}
                    </select>
                    {isChainInherited && (
                        <span className="mt-1 block text-xs text-slate-500">
                            Detected from account address
                        </span>
                    )}
                    {addressFamily === 'evm' && (
                        <span className="mt-1 block text-xs text-slate-500">
                            EVM address — valid on every EVM chain
                        </span>
                    )}
                </div>
            );
        }

        // Address field for on-chain connectors
        if (selectedTypeInfo.required_config.includes('address') ||
            selectedTypeInfo.optional_config.includes('address')) {
            const isRequired = selectedTypeInfo.required_config.includes('address');
            const addressValue = shouldInheritAddress ? accountAddress : (formData.config.address || '');

            fields.push(
                <div key="address">
                    <span className="mb-1 block font-medium">
                        Wallet Address {isRequired && <span className="text-red-500">*</span>}
                    </span>
                    <Input
                        value={addressValue}
                        onChange={(e) => updateConfig('address', e.target.value)}
                        placeholder="0x..."
                        required={isRequired}
                        disabled={shouldInheritAddress}
                    />
                    {shouldInheritAddress && (
                        <span className="mt-1 block text-xs text-slate-500">
                            Inherited from account
                        </span>
                    )}
                </div>
            );
        }

        // Symbols field for CEX connectors
        if (selectedTypeInfo.required_config.includes('symbols') ||
            selectedTypeInfo.optional_config.includes('symbols')) {
            const isRequired = selectedTypeInfo.required_config.includes('symbols');
            fields.push(
                <div key="symbols">
                    <span className="mb-1 block font-medium">
                        Trading Pairs {isRequired && <span className="text-red-500">*</span>}
                    </span>
                    <Textarea
                        value={(formData.config.symbols || []).join(', ')}
                        onChange={(e) => {
                            const symbols = e.target.value
                                .split(',')
                                .map(s => s.trim())
                                .filter(s => s.length > 0);
                            updateConfig('symbols', symbols);
                        }}
                        placeholder="BTCEUR, ETHEUR, SOLUSDT"
                        rows={2}
                    />
                    <span className="mt-1 block text-sm text-slate-500">
                        Comma-separated trading pairs
                    </span>
                </div>
            );
        }

        // Wallet address for connectors that need an explicit on-chain address
        // (e.g. Hyperliquid which queries by wallet address)
        if (selectedTypeInfo.required_config.includes('wallet_address') ||
            selectedTypeInfo.optional_config.includes('wallet_address')) {
            const isRequired = selectedTypeInfo.required_config.includes('wallet_address');
            // For wallet accounts, pre-fill from account address
            const inheritAddress = isWalletAccount && accountAddress;
            const walletValue = inheritAddress
                ? accountAddress
                : (formData.config.wallet_address || '');

            fields.push(
                <div key="wallet_address">
                    <span className="mb-1 block font-medium">
                        Wallet Address {isRequired && <span className="text-red-500">*</span>}
                    </span>
                    <Input
                        value={walletValue}
                        onChange={(e) => updateConfig('wallet_address', e.target.value)}
                        placeholder="0x..."
                        required={isRequired}
                        disabled={!!inheritAddress}
                    />
                    {inheritAddress && (
                        <span className="mt-1 block text-xs text-slate-500">
                            Inherited from account
                        </span>
                    )}
                </div>
            );
        }

        // Start datetime for configuring default sync start
        if (selectedTypeInfo.optional_config.includes('start_datetime')) {
            fields.push(
                <div key="start_datetime">
                    <span className="mb-1 block font-medium">Start Date</span>
                    <Input
                        type="datetime-local"
                        value={formData.config.start_datetime || ''}
                        onChange={(e) => updateConfig('start_datetime', e.target.value || null)}
                    />
                    <span className="mt-1 block text-xs text-slate-500">
                        Default start date for incremental sync
                    </span>
                </div>
            );
        }

        // Timezone selector for file connectors whose CSV timestamps are in a local timezone
        if (selectedTypeInfo.optional_config.includes('timezone')) {
            // Default to browser timezone on create
            const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const currentValue = formData.config.timezone ?? browserTz;

            // Initialize config with browser timezone if not set yet
            if (formData.config.timezone === undefined) {
                // Use a microtask to avoid updating state during render
                Promise.resolve().then(() => updateConfig('timezone', browserTz));
            }

            fields.push(
                <div key="timezone">
                    <span className="mb-1 block font-medium">
                        File Timezone
                    </span>
                    <select
                        value={currentValue}
                        onChange={(e) => updateConfig('timezone', e.target.value)}
                        className="h-9 w-full border border-slate-200 bg-white px-2 text-sm"
                    >
                        {(() => {
                            // Build a curated list of common IANA timezones
                            const commonTimezones = [
                                'UTC',
                                'Europe/London',
                                'Europe/Paris',
                                'Europe/Berlin',
                                'Europe/Amsterdam',
                                'Europe/Brussels',
                                'Europe/Zurich',
                                'Europe/Rome',
                                'Europe/Madrid',
                                'Europe/Lisbon',
                                'Europe/Vienna',
                                'Europe/Warsaw',
                                'Europe/Prague',
                                'Europe/Budapest',
                                'Europe/Bucharest',
                                'Europe/Athens',
                                'Europe/Helsinki',
                                'Europe/Stockholm',
                                'Europe/Oslo',
                                'Europe/Copenhagen',
                                'Europe/Dublin',
                                'Europe/Istanbul',
                                'Europe/Moscow',
                                'Asia/Dubai',
                                'Asia/Kolkata',
                                'Asia/Bangkok',
                                'Asia/Singapore',
                                'Asia/Hong_Kong',
                                'Asia/Shanghai',
                                'Asia/Seoul',
                                'Asia/Tokyo',
                                'Australia/Sydney',
                                'Australia/Melbourne',
                                'Pacific/Auckland',
                                'America/New_York',
                                'America/Chicago',
                                'America/Denver',
                                'America/Los_Angeles',
                                'America/Toronto',
                                'America/Sao_Paulo',
                                'America/Argentina/Buenos_Aires',
                            ];
                            // Ensure browser timezone is in the list
                            const allTimezones = commonTimezones.includes(browserTz)
                                ? commonTimezones
                                : [browserTz, ...commonTimezones];
                            return allTimezones.map(tz => (
                                <option key={tz} value={tz}>
                                    {tz.replace(/_/g, ' ')}{tz === browserTz ? ' (detected)' : ''}
                                </option>
                            ));
                        })()}
                    </select>
                    <span className="mt-1 block text-xs text-slate-500">
                        Timezone of timestamps in the exported CSV file (usually your browser timezone when you exported from OKX)
                    </span>
                </div>
            );
        }

        return fields;
    };

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <RadixDialog.Title className="text-base font-semibold">
                            {connector ? 'Edit Connector' : 'Add Connector'}
                        </RadixDialog.Title>
                    </div>

                    <form onSubmit={handleSubmit}>
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-4">
                                {error && (
                                    <div className="bg-red-50 p-3">
                                        <span className="text-sm text-red-600">{error}</span>
                                    </div>
                                )}

                                {/* Network first (wallet accounts) */}
                                {!connector && isWalletAccount && networkOptions.length > 0 && (
                                    <div>
                                        <span className="mb-1 block font-medium">Network</span>
                                        <select
                                            aria-label="Network"
                                            value={networkFilter}
                                            onChange={(e) => handleNetworkChange(e.target.value)}
                                            className="h-9 w-full border border-slate-200 bg-white px-2 text-sm"
                                        >
                                            <option value="">All networks and connector types</option>
                                            {networkOptions.map(n => (
                                                <option key={n.canonical} value={n.canonical}>
                                                    {n.label}
                                                </option>
                                            ))}
                                        </select>
                                        {addressFamily === 'evm' && (
                                            <span className="mt-1 block text-xs text-slate-500">
                                                EVM address — choose the network this wallet is used on
                                            </span>
                                        )}
                                    </div>
                                )}

                                {/* Connector Type */}
                                <div>
                                    <span className="mb-1 block font-medium">
                                        Connector Type <span className="text-red-500">*</span>
                                    </span>
                                    <select
                                        aria-label="Connector Type"
                                        disabled={!!connector}
                                        value={formData.connector_type}
                                        onChange={(e) => handleTypeChange(e.target.value)}
                                        className="h-9 w-full border border-slate-200 bg-white px-2 text-sm disabled:opacity-50"
                                    >
                                        {!connector && <option value="">Select connector...</option>}
                                        {connector ? (
                                            connectorTypes.map(type => (
                                                <option key={type.type} value={type.type}>
                                                    {type.display_name}
                                                </option>
                                            ))
                                        ) : networkFilter ? (
                                            visibleTypes.map(type => (
                                                <option key={type.type} value={type.type}>
                                                    {formatTypeOption(type, networkFilter)}
                                                </option>
                                            ))
                                        ) : (
                                            groupTypes(visibleTypes).map(g => (
                                                <optgroup key={g.group} label={g.label}>
                                                    {g.types.map(type => (
                                                        <option key={type.type} value={type.type}>
                                                            {formatTypeOption(type)}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            ))
                                        )}
                                    </select>
                                    {selectedTypeInfo && renderTypeDetails(selectedTypeInfo)}
                                    {connector && selectedTypeInfo?.category === 'onchain' &&
                                        selectedTypeInfo.group !== 'app' && renderSwitchProvider()}
                                </div>

                                {/* Dynamic Config Fields */}
                                {renderConfigFields()}

                                {/* Credentials Reference */}
                                <div>
                                    <span className="mb-1 block font-medium">API Key Reference</span>
                                    <Input
                                        value={formData.credentials_ref}
                                        onChange={(e) =>
                                            setFormData(prev => ({ ...prev, credentials_ref: e.target.value }))
                                        }
                                        placeholder="env:BINANCE_API_KEY"
                                    />
                                    <span className="mt-1 block text-sm text-slate-500">
                                        Use env:VAR_NAME to reference environment variable
                                    </span>
                                </div>

                                {/* Sync Priority */}
                                <div>
                                    <span className="mb-1 block font-medium">Sync Priority</span>
                                    <Input
                                        type="number"
                                        value={formData.sync_priority}
                                        onChange={(e) =>
                                            setFormData(prev => ({
                                                ...prev,
                                                sync_priority: parseInt(e.target.value) || 100,
                                            }))
                                        }
                                        min={1}
                                        max={1000}
                                    />
                                    <span className="mt-1 block text-sm text-slate-500">
                                        Lower number = higher priority (synced first)
                                    </span>
                                </div>

                                {/* Color */}
                                <ColorPaletteField
                                    value={formData.color}
                                    onChange={(color) => setFormData(prev => ({ ...prev, color }))}
                                    usedColors={usedColors}
                                />

                                {/* Default File for file connectors */}
                                {selectedTypeInfo?.is_file_connector && (
                                    <div
                                        className={`border p-4 ${defaultFile || defaultFileName ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-transparent'
                                            }`}
                                    >
                                        <span className="mb-2 block font-medium">📁 Default File</span>
                                        <span className="mb-3 block text-sm text-slate-500">
                                            Set a default file to auto-use when syncing this connector.
                                        </span>
                                        {defaultFileName && !defaultFile && (
                                            <div className="mb-2 flex items-center gap-2">
                                                <span className="text-sm text-blue-600">
                                                    Current: {defaultFileName}
                                                </span>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    colorScheme="red"
                                                    onClick={() => setDefaultFileName(null)}
                                                >
                                                    Remove
                                                </Button>
                                            </div>
                                        )}
                                        <input
                                            type="file"
                                            accept={(selectedTypeInfo.type.includes('okx') || selectedTypeInfo.type.includes('degiro')) ? '.csv' : '.xlsx,.xls'}
                                            onChange={(e) => {
                                                const file = e.target.files?.[0] || null;
                                                setDefaultFile(file);
                                            }}
                                            disabled={uploadingDefault}
                                            className="block w-full text-sm"
                                        />
                                        {defaultFile && (
                                            <span className="mt-1 block text-xs text-blue-600">
                                                Will upload: {defaultFile.name}
                                            </span>
                                        )}
                                        {!connector && (
                                            <span className="mt-1 block text-xs text-slate-500">
                                                File will be uploaded after the connector is created.
                                            </span>
                                        )}
                                    </div>
                                )}

                                {/* Test Fixture (edit mode only) */}
                                {connector && (
                                    <div
                                        className={`border p-4 ${testFixtureStatus?.test_mode ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-transparent'
                                            }`}
                                    >
                                        <span className="mb-2 block font-medium">🧪 Test Fixture</span>
                                        <span className="mb-3 block text-sm text-slate-500">
                                            Upload a JSON fixture to use during sync instead of the real API.
                                        </span>
                                        {testFixtureStatus?.has_fixture && (
                                            <div className="mb-2 flex items-center gap-2">
                                                <Badge colorScheme="orange">
                                                    Test Mode Active — {testFixtureStatus.item_count} items
                                                </Badge>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    colorScheme="red"
                                                    onClick={handleRemoveFixture}
                                                    disabled={uploadingFixture}
                                                >
                                                    Remove
                                                </Button>
                                            </div>
                                        )}
                                        {!testFixtureStatus?.has_fixture && (
                                            <>
                                                <input
                                                    type="file"
                                                    accept=".json"
                                                    onChange={(e) => {
                                                        const file = e.target.files?.[0] || null;
                                                        setTestFixtureFile(file);
                                                    }}
                                                    disabled={uploadingFixture}
                                                    className="block w-full text-sm"
                                                />
                                                {testFixtureFile && (
                                                    <div className="mt-2 flex items-center gap-2">
                                                        <span className="text-xs text-orange-600">
                                                            Selected: {testFixtureFile.name}
                                                        </span>
                                                        <Button
                                                            size="sm"
                                                            colorScheme="gray"
                                                            className="bg-orange-600 text-white hover:bg-orange-700"
                                                            onClick={handleUploadFixture}
                                                            loading={uploadingFixture}
                                                        >
                                                            Upload
                                                        </Button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}


                            </div>
                        </div>

                        <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-4">
                            <Button variant="outline" onClick={onClose} disabled={loading}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                colorScheme="blue"
                                loading={loading}
                                disabled={!formData.connector_type}
                            >
                                {connector ? 'Update' : 'Create'}
                            </Button>
                        </div>
                    </form>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default ConnectorFormDialog;
