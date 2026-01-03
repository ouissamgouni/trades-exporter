import React, { useState } from 'react';
import { Box, Tabs, Badge } from '@chakra-ui/react';
import { AssetsEditor } from './AssetsEditor';
import { RawAssetsEditor } from './RawAssetsEditor';
import { CategoriesEditor } from './CategoriesEditor';

/**
 * AssetsSection - Combined view for Assets, Raw Assets, and Categories with tabs
 */
export const AssetsSection: React.FC = () => {
    const [activeTab, setActiveTab] = useState<string>('assets');

    return (
        <Box>
            <Tabs.Root value={activeTab} onValueChange={(e) => setActiveTab(e.value)}>
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="assets">
                        💰 Assets
                    </Tabs.Trigger>
                    <Tabs.Trigger value="raw-assets">
                        🔗 Raw Mappings
                    </Tabs.Trigger>
                    <Tabs.Trigger value="categories">
                        🏷️ Categories
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="assets">
                    <AssetsEditor />
                </Tabs.Content>

                <Tabs.Content value="raw-assets">
                    <RawAssetsEditor />
                </Tabs.Content>

                <Tabs.Content value="categories">
                    <CategoriesEditor />
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default AssetsSection;
