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
import { Badge } from "./ui/primitives";

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
      <button
        type="button"
        key={tab.id}
        className={`px-3 py-1.5 transition-colors md:px-4 ${isActive ? 'bg-slate-700 text-white hover:bg-slate-700 hover:text-white' : 'bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
        onClick={() => handlePrimaryTabChange(tab.id)}
      >
        <div className="flex items-center gap-1.5">
          <TabIcon size={14} />
          <span className={`hidden text-sm sm:inline ${isActive ? 'font-semibold' : 'font-medium'}`}>
            {tab.label}
          </span>
        </div>
      </button>
    );
  };

  const renderSecondaryItem = (item: NavItem) => {
    const isActive = activeItem === item.id;
    const hasWarning = typeof item.badge === 'string' && item.badge.includes('unmapped');
    const ItemIcon = item.icon;

    return (
      <button
        type="button"
        key={item.id}
        className={`px-3 py-1 transition-colors ${isActive ? 'bg-slate-700 text-white hover:bg-slate-700 hover:text-white' : 'bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-700'}`}
        onClick={() => setActiveItem(item.id)}
      >
        <div className="flex items-center gap-1.5">
          <ItemIcon size={12} />
          <span className={`text-xs ${isActive ? 'font-semibold' : 'font-normal'}`}>
            {item.label}
          </span>
          {item.badge && (
            <Badge
              colorScheme={hasWarning ? 'orange' : 'gray'}
              className="rounded-full px-1.5 py-0 text-[10px] font-medium"
            >
              {item.badge}
            </Badge>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-1">
      <div className="flex flex-col gap-2">
        {/* Primary Pill Toggle Group */}
        <div className="inline-flex self-start border border-slate-200 bg-white">
          {primaryTabs.map((tab) => renderPrimaryTab(tab))}
        </div>

        {/* Secondary Sub-Pills */}
        {secondaryItems.length > 0 && (
          <div className="inline-flex flex-wrap self-start border border-slate-200">
            {secondaryItems.map((item) => renderSecondaryItem(item))}
          </div>
        )}

        {/* Content Area */}
        <div className="min-h-[500px] border border-slate-200 bg-white p-3 md:p-4">
          <ActiveComponent />
        </div>
      </div>
    </div>
  );
};

export default UnifiedSetupView;
