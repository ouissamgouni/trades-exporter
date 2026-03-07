import React, { useState, useEffect } from "react";
import {
  Box,
  Heading,
  VStack,
  Container,
  Badge,
  HStack,
  Text,
  Flex,
  Icon,
} from "@chakra-ui/react";
import { FiChevronDown } from "react-icons/fi";
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
  icon: string;
  component: React.FC;
  group?: string;
  status?: boolean;
  badge?: string | number;
  description: string;
}

interface PrimaryTab {
  id: string;
  label: string;
  icon: string;
  status?: boolean;
}

const UnifiedSetupView: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [activeItem, setActiveItem] = useState<string>("accounts");
  const [activePrimaryTab, setActivePrimaryTab] = useState<string>("accounts");

  // Fetch setup status on mount and when tab becomes active
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

  // Navigation items organized by primary tabs
  const navItems: NavItem[] = [

    {
      id: "accounts",
      label: "Accounts & Connectors",
      icon: "👤",
      group: "accounts",
      component: AccountsManagement,
      status: setupStatus?.accounts_configured && setupStatus?.connectors_configured,
      badge: setupStatus?.accounts_count ? `${setupStatus.accounts_count}` : undefined,
      description: "Manage trading accounts with inline connectors",
    },
    {
      id: "raw-accounts",
      label: "Account Mappings",
      icon: "🔗",
      group: "accounts",
      component: RawAccountsEditor,
      status: !setupStatus?.unmapped_raw_accounts_count,
      badge: setupStatus?.unmapped_raw_accounts_count ? `${setupStatus.unmapped_raw_accounts_count} unmapped` : undefined,
      description: "Link source accounts to normalized accounts",
    },
    {
      id: "assets",
      label: "Assets",
      icon: "💰",
      group: "assets",
      component: AssetsEditor,
      status: setupStatus?.assets_configured,
      badge: setupStatus?.assets_count ? `${setupStatus.assets_count}` : undefined,
      description: "Configure tradable assets and price sources",
    },
    {
      id: "raw-assets",
      label: "Asset Mappings",
      icon: "🔗",
      group: "assets",
      component: RawAssetsEditor,
      status: !setupStatus?.unmapped_raw_assets_count,
      badge: setupStatus?.unmapped_raw_assets_count ? `${setupStatus.unmapped_raw_assets_count} unmapped` : undefined,
      description: "Link source symbols to normalized assets",
    },
    {
      id: "categories",
      label: "Categories",
      icon: "🏷️",
      group: "assets",
      component: CategoriesEditor,
      status: true,
      description: "Organize assets by sector, region, etc.",
    },
    {
      id: "pnl-defaults",
      label: "P&L Defaults",
      icon: "📊",
      component: PnLDefaultsEditor,
      status: setupStatus?.base_currency_set,
      badge: setupStatus?.base_currency_symbol || undefined,
      description: "Base currency & default P&L calculation settings",
    },
  ];

  // Primary tabs (top-level categories)
  const primaryTabs: PrimaryTab[] = [
    {
      id: "accounts",
      label: "Accounts",
      icon: "👤",
      status: setupStatus?.accounts_configured && !setupStatus?.unmapped_raw_accounts_count,
    },
    {
      id: "assets",
      label: "Assets",
      icon: "💰",
      status: setupStatus?.assets_configured && !setupStatus?.unmapped_raw_assets_count,
    },
    {
      id: "pnl-defaults",
      label: "P&L Settings",
      icon: "📊",
      status: setupStatus?.base_currency_set,
    },
  ];

  // Get secondary items for current primary tab
  const getSecondaryItems = () => {
    if (activePrimaryTab === "pnl-defaults") return [];
    return navItems.filter((item) => item.group === activePrimaryTab);
  };

  const secondaryItems = getSecondaryItems();

  const ActiveComponent = navItems.find((item) => item.id === activeItem)?.component || PnLDefaultsEditor;

  // Calculate completion percentage
  const completionPercentage = setupStatus
    ? Math.round(
      (setupStatus.base_currency_set ? 25 : 0) +
      (setupStatus.accounts_count > 0 ? 25 : 0) +
      (setupStatus.unmapped_raw_accounts_count ? 0 : 25) +
      (setupStatus.unmapped_raw_assets_count ? 0 : 25)
    )
    : 0;

  // Handle primary tab change
  const handlePrimaryTabChange = (tabId: string) => {
    setActivePrimaryTab(tabId);
    if (tabId === "pnl-defaults") {
      setActiveItem(tabId);
    } else {
      // Set to first item in the group
      const firstItem = navItems.find((item) => item.group === tabId);
      if (firstItem) setActiveItem(firstItem.id);
    }
  };

  // Render primary tab button
  const renderPrimaryTab = (tab: PrimaryTab) => {
    const isActive = activePrimaryTab === tab.id;
    const hasWarning = tab.status === false;
    const hasSubItems = tab.id !== "pnl-defaults";

    return (
      <Box
        key={tab.id}
        px={{ base: 2, md: 3 }}
        py={2}
        borderRadius="md"
        cursor="pointer"
        bg={isActive ? "blue.500" : "white"}
        color={isActive ? "white" : "gray.700"}
        borderWidth={1}
        borderColor={isActive ? "blue.500" : (hasWarning ? "orange.300" : "gray.200")}
        _hover={{
          bg: isActive ? "blue.600" : "gray.50",
          borderColor: isActive ? "blue.600" : "blue.300"
        }}
        onClick={() => handlePrimaryTabChange(tab.id)}
        transition="all 0.2s"
        minW={{ base: "auto", md: "110px" }}
      >
        <HStack justify="center" gap={1.5}>
          <Text fontSize={{ base: "sm", md: "md" }}>{tab.icon}</Text>
          <Text fontWeight="semibold" fontSize={{ base: "xs", md: "sm" }} display={{ base: "none", sm: "block" }}>
            {tab.label}
          </Text>
          {hasSubItems && (
            <Icon
              as={FiChevronDown}
              boxSize={3}
              color={isActive ? "white" : "gray.400"}
            />
          )}
          {tab.status !== undefined && (
            <Text fontSize="2xs">
              {tab.status ? "✓" : "⚠"}
            </Text>
          )}
        </HStack>
      </Box>
    );
  };

  // Render secondary item (pill style)
  const renderSecondaryItem = (item: NavItem) => {
    const isActive = activeItem === item.id;
    const hasWarning = item.status === false || (typeof item.badge === 'string' && item.badge.includes('unmapped'));

    return (
      <Box
        key={item.id}
        px={3}
        py={1.5}
        borderRadius="full"
        cursor="pointer"
        bg={isActive ? "blue.50" : "white"}
        borderWidth={1}
        borderColor={isActive ? "blue.400" : (hasWarning ? "orange.200" : "gray.200")}
        _hover={{
          bg: isActive ? "blue.100" : "gray.50",
          borderColor: isActive ? "blue.500" : "blue.200"
        }}
        onClick={() => setActiveItem(item.id)}
        transition="all 0.2s"
      >
        <HStack gap={1.5}>
          <Text fontSize="xs">{item.icon}</Text>
          <Text fontWeight={isActive ? "semibold" : "medium"} fontSize="xs">
            {item.label}
          </Text>
          {item.badge && (
            <Badge
              size="xs"
              colorScheme={hasWarning ? "orange" : "gray"}
              variant={hasWarning ? "solid" : "subtle"}
            >
              {item.badge}
            </Badge>
          )}
          {item.status !== undefined && !item.badge && (
            <Text fontSize="2xs" color={item.status ? "green.500" : "orange.400"}>
              {item.status ? "✓" : "⚠"}
            </Text>
          )}
        </HStack>
      </Box>
    );
  };

  return (
    <Container maxW="container.xl" py={1}>
      <VStack align="stretch" gap={1}>
        {/* Header with overall progress */}
        <Flex justify="space-between" align="right" mb={2} flexWrap="wrap" gap={3}>
          <Badge
            colorScheme={completionPercentage === 100 ? "green" : "orange"}
            fontSize="xs"
            px={3}
            py={1}
            borderRadius="md"
          >
            {completionPercentage}% Complete
          </Badge>
        </Flex>

        {/* Horizontal Two-Tier Navigation */}
        <Box
          borderWidth={1}
          borderRadius="lg"
          bg="white"
          p={{ base: 2, md: 3 }}
        >
          {/* Primary Tabs Row */}
          <HStack
            gap={{ base: 1.5, md: 2 }}
            mb={secondaryItems.length > 0 ? 3 : 0}
            flexWrap={{ base: "wrap", md: "nowrap" }}
            justify={{ base: "center", md: "flex-start" }}
          >
            {primaryTabs.map((tab) => renderPrimaryTab(tab))}
          </HStack>

          {/* Secondary Items Row (Pills) */}
          {secondaryItems.length > 0 && (
            <Box
              pt={3}
              borderTopWidth={1}
              borderColor="gray.100"
            >
              <Flex
                gap={1.5}
                flexWrap="wrap"
                justify={{ base: "center", md: "flex-start" }}
              >
                {secondaryItems.map((item) => renderSecondaryItem(item))}
              </Flex>
            </Box>
          )}
        </Box>

        {/* Content Area */}
        <Box
          borderWidth={1}
          borderRadius="lg"
          p={{ base: 4, md: 6 }}
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
