import React from 'react';
import { Button, Flex } from '@chakra-ui/react';
import { FiList } from 'react-icons/fi';
import { LuLayoutGrid, LuChartPie } from 'react-icons/lu';

export type AssetsViewMode = 'list' | 'treemap' | 'pie';

interface ViewModeToggleProps {
    value: AssetsViewMode;
    onChange: (mode: AssetsViewMode) => void;
}

const MODES: { key: AssetsViewMode; label: string; icon: React.ReactNode }[] = [
    { key: 'list', label: 'List', icon: <FiList size={14} /> },
    { key: 'treemap', label: 'Treemap', icon: <LuLayoutGrid size={14} /> },
    { key: 'pie', label: 'Pie', icon: <LuChartPie size={14} /> },
];

export const ViewModeToggle: React.FC<ViewModeToggleProps> = ({ value, onChange }) => (
    <Flex align="center" gap={1}>
        <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden">
            {MODES.map(({ key, label, icon }) => (
                <Button
                    key={key}
                    size="xs"
                    variant={value === key ? 'solid' : 'ghost'}
                    colorPalette="gray"
                    borderRadius="0"
                    onClick={() => onChange(key)}
                    px={2.5}
                    fontSize="xs"
                    gap={1}
                >
                    {icon}
                    {label}
                </Button>
            ))}
        </Flex>
    </Flex>
);
