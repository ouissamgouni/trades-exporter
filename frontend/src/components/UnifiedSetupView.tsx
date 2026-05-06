import React, { useState, useEffect } from "react";
import {
  Box,
  VStack,
  Container,
  Badge,
  HStack,
  Text,
  Flex,
} from "@chakra-ui/react";
import {
  FiUser,
  FiDollarSign,
  FiBarChart2,
  FiLink,
  FiTag,
} from "react-icons/fi";
import AccountsManagement from "./AccountsManagement";
import { RawAccountsEditor } from "./RawAccountsEditor";
import { AssetsEditor } from "./AssetsEditor";
import { RawAssetsEditor } from "./RawAssetsEditor";
import { CategoriesEditor } from "./CategoriesEditor";
import { PnLDefaultsEditor } from "./PnLDefaultsEditor";
import { API_URL } from "../types";

interface SetupStatus {
  accounts_configured: boolean;
  accounts_count: number;
  connectors_configured: boolean;
  connectors_count: number;
  assets_configured: boolean;
  assets_count: number;
  base_currency_set: boolean;
  base_currency_symbol: string | null;
  unmapped_raw_assets_count?: number;
  unmapped_raw_accounts_count?: number;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  component: React.FC;
  group?: string;
  badge?: string | number;
}

interface PrimaryTab {
  id: string;
  label: string;
  icon: React.ElementType;
}

const UnifiedSetupView: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [activeItem, setActiveItem] = useState<string>("accounts");
  const [activePrimaryTab, setActivePrimaryTab] = useState<string>("accounts");

  useEffect(() => {
    if (!isActive) return;
    fetchSetupStatus();
  }, [isActive]);

  const fetchSetupStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/config/setup-status`);
      const data = await response.json();
      setSetupStatus(data);
    } catch (error) {
      console.error("Error fetching setup status:", error);
    }
  };

  const navItems: NavItem[] = [
    {
      id: "accounts",
      label: "Accounts & Connectors",
      icon: FiUser,
      group: "accounts",
      component: AccountsManagement,
      badge: setupStatus?.accounts_count ? `${setupStatus.accounts_count}` : undefined,
    },
    {
      id: "raw-accounts",
      label: "Account Mappings",
      icon: FiLink,
      group: "accounts",
      component: RawAccountsEditor,
      badge: setupStatus?.unmapped_raw_accounts_count ? `${setupStatus.unmapped_raw_accounts_count} unmapped` : undefined,
    },
    {
      id: "assets",
      label: "Assets",
      icon: FiDollarSign,
      group: "assets",
      component: AssetsEditor,
      badge: setupStatus?.assets_count ? `${setupStatus.assets_count}` : undefined,
    },
    {
      id: "raw-assets",
      label: "Asset Mappings",
      icon: FiLink,
      group: "assets",
      component: RawAssetsEditor,
      badge: setupStatus?.unmapped_raw_assets_count ? `${setupStatus.unmapped_raw_assets_count} unmapped` : undefined,
    },
    {
      id: "categories",
      label: "Categories",
      icon: FiTag,
      group: "assets",
      component: CategoriesEditor,
    },
    {
      id: "pnl-defaults",
      label: "P&L Defaults",
      icon: FiBarChart2,
      component: PnLDefaultsEditor,
      badge: setupStatus?.base_currency_symbol || undefined,
    },
  ];

  const primaryTabs: PrimaryTab[] = [
    {
      id: "accounts",
      label: "Accounts",
      icon: FiUser,
    },
    {
      id: "assets",
      label: "Assets",
      icon: FiDollarSign,
    },
    {
      id: "pnl-defaults",
      label: "P&L Settings",
      icon: FiBarChart2,
    },
  ];

  const getSecondaryItems = () => {
    if (activePrimaryTab === "pnl-defaults") return [];
    return navItems.filter((item) => item.group === activePrimaryTab);
  };

  const secondaryItems = getSecondaryItems();
  const ActiveComponent = navItems.find((item) => item.id === activeItem)?.component || PnLDefaultsEditor;

  const handlePrimaryTabChange = (tabId: string) => {
    setActivePrimaryTab(tabId);
    if (tabId === "pnl-defaults") {
      setActiveItem(tabId);
    } else {
      const firstItem = navItems.find((item) => item.group === tabId);
      if (firstItem) setActiveItem(firstItem.id);
    }
  };

  const renderPrimaryTab = (tab: PrimaryTab) => {
    const isActive = activePrimaryTab === tab.id;
    const TabIcon = tab.icon;

    return (
      <Box
        key={tab.id}
        px={{ base: 3, md: 4 }}
        py={1.5}
        borderRadius="0"
        cursor="pointer"
        bg={isActive ? "gray.700" : "white"}
        color={isActive ? "white" : "gray.500"}
        _hover={{
          color: isActive ? "white" : "gray.700",
          bg: isActive ? "gray.700" : "gray.50",
        }}
        onClick={() => handlePrimaryTabChange(tab.id)}
        transition="all 0.15s ease"
      >
        <HStack gap={1.5}>
          <Box as={TabIcon} boxSize="14px" />
          <Text
            fontWeight={isActive ? "600" : "500"}
            fontSize="sm"
            display={{ base: "none", sm: "block" }}
          >
            {tab.label}
          </Text>
        </HStack>
      </Box>
    );
  };

  const renderSecondaryItem = (item: NavItem) => {
    const isActive = activeItem === item.id;
    const hasWarning = typeof item.badge === 'string' && item.badge.includes('unmapped');
    const ItemIcon = item.icon;

    return (
      <Box
        key={item.id}
        px={3}
        py={1}
        borderRadius="0"
        cursor="pointer"
        bg={isActive ? "gray.700" : "white"}
        color={isActive ? "white" : "gray.600"}
        _hover={{
          bg: isActive ? "gray.700" : "gray.50",
          color: isActive ? "white" : "gray.700",
        }}
        onClick={() => setActiveItem(item.id)}
        transition="all 0.15s ease"
      >
        <HStack gap={1.5}>
          <Box as={ItemIcon} boxSize="12px" />
          <Text fontWeight={isActive ? "600" : "400"} fontSize="xs">
            {item.label}
          </Text>
          {item.badge && (
            <Badge
              fontSize="2xs"
              px={1.5}
              py={0}
              borderRadius="full"
              bg={hasWarning ? "orange.100" : "gray.100"}
              color={hasWarning ? "orange.700" : "gray.600"}
              fontWeight="500"
            >
              {item.badge}
            </Badge>
          )}
        </HStack>
      </Box>
    );
  };

  return (
    <Container maxW="container.xl" py={1}>
      <VStack align="stretch" gap={2}>
        {/* Primary Pill Toggle Group */}
        <HStack
          bg="white"
          borderRadius="0"
          p={0}
          gap={0}
          borderWidth={1}
          borderColor="gray.200"
          alignSelf="flex-start"
        >
          {primaryTabs.map((tab) => renderPrimaryTab(tab))}
        </HStack>

        {/* Secondary Sub-Pills */}
        {secondaryItems.length > 0 && (
          <HStack
            gap={0}
            borderWidth={1}
            borderColor="gray.200"
            alignSelf="flex-start"
            flexWrap="wrap"
          >
            {secondaryItems.map((item) => renderSecondaryItem(item))}
          </HStack>
        )}

        {/* Content Area */}
        <Box
          borderWidth={1}
          borderColor="gray.200"
          borderRadius="0"
          p={{ base: 3, md: 4 }}
          bg="white"
          minH="500px"
        >
          <ActiveComponent />
        </Box>
      </VStack>
    </Container>
  );
};

export default UnifiedSetupView;
