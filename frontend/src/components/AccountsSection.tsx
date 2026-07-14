import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';
import AccountsManagement from './AccountsManagement';
import { RawAccountsEditor } from './RawAccountsEditor';
import ConnectorsManager from './ConnectorsManager';

/**
 * AccountsSection - Combined view for Accounts, Connectors, and Raw Accounts with tabs
 */
export const AccountsSection: React.FC = () => {
    const [activeTab, setActiveTab] = useState<string>('accounts');

    return (
        <div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                    <TabsTrigger value="accounts">
                        👤 Accounts
                    </TabsTrigger>
                    <TabsTrigger value="connectors">
                        🔌 Connectors
                    </TabsTrigger>
                    <TabsTrigger value="raw-accounts">
                        🔗 Raw Mappings
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="accounts">
                    <AccountsManagement />
                </TabsContent>

                <TabsContent value="connectors">
                    <ConnectorsManager />
                </TabsContent>

                <TabsContent value="raw-accounts">
                    <RawAccountsEditor />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AccountsSection;
