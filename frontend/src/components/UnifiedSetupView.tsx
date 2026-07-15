import React, { useState, useEffect } from "react";
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
import { Badge, Tabs, TabsList, TabsTrigger } from "./ui/primitives";
import { PANEL, PANEL_BODY } from "../lib/ui";

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

  return (
    <div className="mx-auto max-w-7xl px-4 py-1">
      <div className="flex flex-col gap-2">
        {/* Primary navigation (matches app-level tab style) */}
        <Tabs value={activePrimaryTab} onValueChange={handlePrimaryTabChange}>
          <TabsList>
            {primaryTabs.map((tab) => {
              const TabIcon = tab.icon;
              return (
                <TabsTrigger key={tab.id} value={tab.id}>
                  <span className="inline-flex items-center gap-1.5">
                    <TabIcon size={14} />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        {/* Secondary sub-navigation (subordinate segment style) */}
        {secondaryItems.length > 0 && (
          <Tabs value={activeItem} onValueChange={setActiveItem} variant="segment">
            <TabsList>
              {secondaryItems.map((item) => {
                const ItemIcon = item.icon;
                const hasWarning = typeof item.badge === 'string' && item.badge.includes('unmapped');
                return (
                  <TabsTrigger key={item.id} value={item.id}>
                    <span className="inline-flex items-center gap-1.5">
                      <ItemIcon size={12} />
                      {item.label}
                      {item.badge && (
                        <Badge
                          colorScheme={hasWarning ? 'orange' : 'gray'}
                          className="px-1.5 py-0 text-[10px] font-medium"
                        >
                          {item.badge}
                        </Badge>
                      )}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        )}

        {/* Content Area */}
        <div className={`min-h-[500px] ${PANEL} ${PANEL_BODY}`}>
          <ActiveComponent />
        </div>
      </div>
    </div>
  );
};

export default UnifiedSetupView;
