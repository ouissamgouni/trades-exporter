import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';
import { AssetsEditor } from './AssetsEditor';
import { RawAssetsEditor } from './RawAssetsEditor';
import { CategoriesEditor } from './CategoriesEditor';

/**
 * AssetsSection - Combined view for Assets, Raw Assets, and Categories with tabs
 */
export const AssetsSection: React.FC = () => {
    const [activeTab, setActiveTab] = useState<string>('assets');

    return (
        <div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                    <TabsTrigger value="assets">
                        💰 Assets
                    </TabsTrigger>
                    <TabsTrigger value="raw-assets">
                        🔗 Raw Mappings
                    </TabsTrigger>
                    <TabsTrigger value="categories">
                        🏷️ Categories
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="assets">
                    <AssetsEditor />
                </TabsContent>

                <TabsContent value="raw-assets">
                    <RawAssetsEditor />
                </TabsContent>

                <TabsContent value="categories">
                    <CategoriesEditor />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AssetsSection;
