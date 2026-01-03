import React, { useState, useEffect } from "react";
import {
  Box,
  Heading,
  VStack,
  Container,
  Badge,
  HStack,
  Text,
} from "@chakra-ui/react";
import { AccountsSection } from "./AccountsSection";
import { AssetsSection } from "./AssetsSection";
import { BaseCurrencySelector } from "./BaseCurrencySelector";
import { API_URL } from "../types";

interface SetupStatus {
  accounts_configured: boolean;
  connectors_configured: boolean;
  assets_configured: boolean;
  base_currency_set: boolean;
}

const UnifiedSetupView: React.FC = () => {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [activeSection, setActiveSection] = useState<string>("pnl");

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

  const sections = [
    {
      id: "pnl",
      label: "📊 P&L",
      component: BaseCurrencySelector,
      status: setupStatus?.base_currency_set,
      description: "Configure base currency for P&L calculations",
    },
    {
      id: "accounts",
      label: "👤 Accounts",
      component: AccountsSection,
      status: setupStatus?.accounts_configured && setupStatus?.connectors_configured,
      description: "Manage accounts, connectors, and raw mappings",
    },
    {
      id: "assets",
      label: "💰 Assets",
      component: AssetsSection,
      status: setupStatus?.assets_configured,
      description: "Manage assets, raw mappings, and categories",
    },
  ];

  const ActiveComponent = sections.find((s) => s.id === activeSection)?.component || BaseCurrencySelector;

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

        {/* Two-column layout: Sidebar + Content */}
        <Box display="flex" gap={6}>
          {/* Left Sidebar - Navigation */}
          <Box
            width="280px"
            flexShrink={0}
            borderWidth={1}
            borderRadius="lg"
            p={4}
            bg="white"
            height="fit-content"
          >
            <VStack align="stretch" gap={2}>
              {sections.map((section) => (
                <Box
                  key={section.id}
                  p={3}
                  borderRadius="md"
                  cursor="pointer"
                  bg={activeSection === section.id ? "blue.50" : "transparent"}
                  borderWidth={1}
                  borderColor={
                    activeSection === section.id ? "blue.300" : "transparent"
                  }
                  _hover={{ bg: "gray.50" }}
                  onClick={() => setActiveSection(section.id)}
                  transition="all 0.2s"
                >
                  <HStack justify="space-between" mb={1}>
                    <Text fontWeight="medium" fontSize="sm">
                      {section.label}
                    </Text>
                    {section.status !== undefined && (
                      <Text color={section.status ? "green.500" : "orange.400"}>
                        {section.status ? "✓" : "⚠"}
                      </Text>
                    )}
                  </HStack>
                  <Text fontSize="xs" color="gray.600">
                    {section.description}
                  </Text>
                </Box>
              ))}
            </VStack>
          </Box>

          {/* Right Content Area */}
          <Box flex={1} borderWidth={1} borderRadius="lg" p={6} bg="white">
            <ActiveComponent />
          </Box>
        </Box>
      </VStack>
    </Container>
  );
};

export default UnifiedSetupView;
