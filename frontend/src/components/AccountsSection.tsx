import React, { useState } from 'react';
import { Box, Tabs } from '@chakra-ui/react';
import AccountsManagement from './AccountsManagement';
import { RawAccountsEditor } from './RawAccountsEditor';
import ConnectorsManager from './ConnectorsManager';

/**
 * AccountsSection - Combined view for Accounts, Connectors, and Raw Accounts with tabs
 */
export const AccountsSection: React.FC = () => {
    const [activeTab, setActiveTab] = useState<string>('accounts');

    return (
        <Box>
            <Tabs.Root value={activeTab} onValueChange={(e) => setActiveTab(e.value)}>
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="accounts">
                        👤 Accounts
                    </Tabs.Trigger>
                    <Tabs.Trigger value="connectors">
                        🔌 Connectors
                    </Tabs.Trigger>
                    <Tabs.Trigger value="raw-accounts">
                        🔗 Raw Mappings
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="accounts">
                    <AccountsManagement />
                </Tabs.Content>

                <Tabs.Content value="connectors">
                    <ConnectorsManager />
                </Tabs.Content>

                <Tabs.Content value="raw-accounts">
                    <RawAccountsEditor />
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default AccountsSection;
