import React, { Suspense } from 'react';
import { Box, Tabs, Spinner, Flex } from '@chakra-ui/react';

// Lazy load the components
const ManualTransactionForm = React.lazy(() => import('./ManualTransactionForm').then(m => ({ default: m.ManualTransactionForm })));
const ImportCSVPanel = React.lazy(() => import('./ImportCSVPanel').then(m => ({ default: m.ImportCSVPanel })));

const LoadingFallback = () => (
    <Flex justify="center" align="center" py={8}>
        <Spinner size="lg" color="teal.500" />
    </Flex>
);

interface AddImportPanelProps {
    onDataChange?: () => void;
}

export const AddImportPanel: React.FC<AddImportPanelProps> = ({ onDataChange }) => {
    return (
        <Box>
            <Tabs.Root defaultValue="manual">
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="manual">
                        ✏️ Manual Entry
                    </Tabs.Trigger>
                    <Tabs.Trigger value="import">
                        📁 Import CSV
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="manual">
                    <Suspense fallback={<LoadingFallback />}>
                        <ManualTransactionForm />
                    </Suspense>
                </Tabs.Content>

                <Tabs.Content value="import">
                    <Suspense fallback={<LoadingFallback />}>
                        <ImportCSVPanel onDataChange={onDataChange} />
                    </Suspense>
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default AddImportPanel;
