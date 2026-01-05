import React, { useState, useEffect } from "react";
import {
  Box,
  Heading,
  VStack,
  Container,
  Badge,
  HStack,
  Text,
  Collapsible,
  Icon,
} from "@chakra-ui/react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import AccountsManagement from "./AccountsManagement";
import { RawAccountsEditor } from "./RawAccountsEditor";
import { AssetsEditor } from "./AssetsEditor";
import { RawAssetsEditor } from "./RawAssetsEditor";
import { CategoriesEditor } from "./CategoriesEditor";
import { BaseCurrencySelector } from "./BaseCurrencySelector";
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

// Flattened navigation structure - all items at one level with optional grouping
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

const UnifiedSetupView: React.FC = () => {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [activeItem, setActiveItem] = useState<string>("base-currency");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["accounts", "assets"]));

  useEffect(() => {
    fetchSetupStatus();
  }, []);

  const fetchSetupStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/config/setup-status`);
      const data = await response.json();
      setSetupStatus(data);
    } catch (error) {
      console.error("Error fetching setup status:", error);
    }
  };

  // Flattened navigation items - direct access to all configuration areas
  const navItems: NavItem[] = [
    {
      id: "base-currency",
      label: "Base Currency",
      icon: "💵",
      component: BaseCurrencySelector,
      status: setupStatus?.base_currency_set,
      badge: setupStatus?.base_currency_symbol || undefined,
      description: "Set currency for P&L calculations",
    },
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
  ];

  // Group items for collapsible sections
  const groups = [
    { id: "accounts", label: "Accounts", icon: "👤" },
    { id: "assets", label: "Assets", icon: "💰" },
  ];

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const ActiveComponent = navItems.find((item) => item.id === activeItem)?.component || BaseCurrencySelector;

  const completionPercentage = setupStatus
    ? Math.round(
      ((setupStatus.accounts_configured ? 1 : 0) +
        (setupStatus.connectors_configured ? 1 : 0) +
        (setupStatus.assets_configured ? 1 : 0) +
        (setupStatus.base_currency_set ? 1 : 0)) /
      4 *
      100
    )
    : 0;

  // Render a single nav item
  const renderNavItem = (item: NavItem, indent: boolean = false) => {
    const isActive = activeItem === item.id;
    const hasWarning = item.status === false || (typeof item.badge === 'string' && item.badge.includes('unmapped'));

    return (
      <Box
        key={item.id}
        p={2}
        pl={indent ? 6 : 2}
        borderRadius="md"
        cursor="pointer"
        bg={isActive ? "blue.50" : "transparent"}
        borderWidth={1}
        borderColor={isActive ? "blue.300" : "transparent"}
        _hover={{ bg: isActive ? "blue.50" : "gray.50" }}
        onClick={() => setActiveItem(item.id)}
        transition="all 0.15s"
      >
        <HStack justify="space-between">
          <HStack gap={2}>
            <Text fontSize="sm">{item.icon}</Text>
            <Text fontWeight={isActive ? "semibold" : "medium"} fontSize="sm">
              {item.label}
            </Text>
          </HStack>
          <HStack gap={1}>
            {item.badge && (
              <Badge
                size="sm"
                colorScheme={hasWarning ? "orange" : "gray"}
                variant={hasWarning ? "solid" : "subtle"}
              >
                {item.badge}
              </Badge>
            )}
            {item.status !== undefined && !item.badge && (
              <Text fontSize="xs" color={item.status ? "green.500" : "orange.400"}>
                {item.status ? "✓" : "⚠"}
              </Text>
            )}
          </HStack>
        </HStack>
        <Text fontSize="xs" color="gray.500" ml={6} mt={0.5}>
          {item.description}
        </Text>
      </Box>
    );
  };

  return (
    <Container maxW="container.xl" py={8}>
      <VStack align="stretch" gap={6}>
        {/* Header with overall progress */}
        <Box>
          <HStack justify="space-between" mb={2}>
            <Heading size="lg">Setup & Configuration</Heading>
            <Badge
              colorScheme={completionPercentage === 100 ? "green" : "orange"}
              fontSize="md"
              px={3}
              py={1}
              borderRadius="md"
            >
              {completionPercentage}% Complete
            </Badge>
          </HStack>
          <Text color="gray.600">
            Configure your accounts, connectors, and assets to get started
          </Text>
        </Box>

        {/* Two-column layout: Flat Navigation Sidebar + Content */}
        <Box display="flex" gap={6}>
          {/* Left Sidebar - Flattened Tree Navigation */}
          <Box
            width="280px"
            flexShrink={0}
            borderWidth={1}
            borderRadius="lg"
            p={3}
            bg="white"
            height="fit-content"
          >
            <VStack align="stretch" gap={1}>
              {/* Standalone items (no group) */}
              {navItems
                .filter((item) => !item.group)
                .map((item) => renderNavItem(item))}

              {/* Grouped items with collapsible headers */}
              {groups.map((group) => {
                const groupItems = navItems.filter((item) => item.group === group.id);
                const isExpanded = expandedGroups.has(group.id);
                const groupHasWarning = groupItems.some(
                  (item) => item.status === false || (typeof item.badge === 'string' && item.badge.includes('unmapped'))
                );

                return (
                  <Box key={group.id}>
                    {/* Group Header */}
                    <Box
                      p={2}
                      borderRadius="md"
                      cursor="pointer"
                      _hover={{ bg: "gray.50" }}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <HStack justify="space-between">
                        <HStack gap={2}>
                          <Icon as={isExpanded ? FiChevronDown : FiChevronRight} boxSize={4} color="gray.500" />
                          <Text fontSize="sm">{group.icon}</Text>
                          <Text fontWeight="semibold" fontSize="sm" color="gray.700">
                            {group.label}
                          </Text>
                        </HStack>
                        {groupHasWarning && (
                          <Text fontSize="xs" color="orange.400">⚠</Text>
                        )}
                      </HStack>
                    </Box>

                    {/* Group Items */}
                    <Collapsible.Root open={isExpanded}>
                      <Collapsible.Content>
                        <VStack align="stretch" gap={0.5} mt={1}>
                          {groupItems.map((item) => renderNavItem(item, true))}
                        </VStack>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  </Box>
                );
              })}
            </VStack>
          </Box>

          {/* Right Content Area */}
          <Box flex={1} borderWidth={1} borderRadius="lg" p={6} bg="white" minH="500px">
            <ActiveComponent />
          </Box>
        </Box>
      </VStack>
    </Container>
  );
};

export default UnifiedSetupView;
