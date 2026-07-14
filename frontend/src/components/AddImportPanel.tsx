import React, { Suspense, useState } from 'react';
import { Spinner, Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';

// Lazy load the components
const ManualTransactionForm = React.lazy(() => import('./ManualTransactionForm').then(m => ({ default: m.ManualTransactionForm })));
const ImportCSVPanel = React.lazy(() => import('./ImportCSVPanel').then(m => ({ default: m.ImportCSVPanel })));

const LoadingFallback = () => (
    <div className="flex items-center justify-center py-8">
        <Spinner size="lg" className="text-green-500" />
    </div>
);

interface AddImportPanelProps {
    onDataChange?: () => void;
}

export const AddImportPanel: React.FC<AddImportPanelProps> = ({ onDataChange }) => {
    const [activeTab, setActiveTab] = useState('manual');
    return (
        <div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                    <TabsTrigger value="manual">
                        ✏️ Manual Entry
                    </TabsTrigger>
                    <TabsTrigger value="import">
                        📁 Import CSV
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="manual">
                    <Suspense fallback={<LoadingFallback />}>
                        <ManualTransactionForm />
                    </Suspense>
                </TabsContent>

                <TabsContent value="import">
                    <Suspense fallback={<LoadingFallback />}>
                        <ImportCSVPanel onDataChange={onDataChange} />
                    </Suspense>
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AddImportPanel;
