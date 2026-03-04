"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
	ChevronUp,
	ComputerIcon,
	ExternalLink,
	MoonIcon,
	Shield,
	SunIcon,
	User as UserIcon,
} from "lucide-react";
import Link from "next/link";
import {
	usePathname,
	useRouter,
	useSearchParams,
	type ReadonlyURLSearchParams,
} from "next/navigation";
import { useTheme } from "next-themes";
import { usePostHog } from "posthog-js/react";
import { useMemo, useState } from "react";

import {
	AnimatedActivity,
	AnimatedBarChart3,
	AnimatedChartColumnBig,
	AnimatedKey,
	AnimatedKeyRound,
	AnimatedLayoutDashboard,
	AnimatedMessageSquare,
	AnimatedSettings,
	AnimatedPercent,
	AnimatedShield,
	AnimatedShieldAlert,
} from "@/components/dashboard/animated-nav-icons";
import { useDashboardNavigation } from "@/hooks/useDashboardNavigation";
import { useUser } from "@/hooks/useUser";
import { clearLastUsedProjectCookiesAction } from "@/lib/actions/last-used-project";
import { useAuth } from "@/lib/auth-client";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/lib/components/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/lib/components/select";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarRail,
	useSidebar,
} from "@/lib/components/sidebar";
import Logo from "@/lib/icons/Logo";
import { buildUrlWithParams } from "@/lib/navigation-utils";

import { OrganizationSwitcher } from "./organization-switcher";

import type { AnimatedIconProps } from "@/components/dashboard/animated-nav-icons";
import type { Organization, User } from "@/lib/types";
import type { Route } from "next";

type AnimatedIconComponent = React.ComponentType<AnimatedIconProps>;

// Configuration
const PROJECT_NAVIGATION: readonly {
	href: string;
	label: string;
	icon: AnimatedIconComponent;
}[] = [
	{
		href: "",
		label: "Dashboard",
		icon: AnimatedLayoutDashboard,
	},
	{
		href: "activity",
		label: "Activity",
		icon: AnimatedActivity,
	},
	{
		href: "model-usage",
		label: "Model Usage",
		icon: AnimatedChartColumnBig,
	},
	{
		href: "usage",
		label: "Usage & Metrics",
		icon: AnimatedBarChart3,
	},
	{
		href: "api-keys",
		label: "API Keys",
		icon: AnimatedKey,
	},
];

const PROJECT_SETTINGS = [
	{
		href: "settings/preferences",
		label: "Preferences",
	},
] as const;

const ORGANIZATION_SETTINGS = [
	{
		href: "org/policies",
		label: "Policies",
	},
	{
		href: "org/preferences",
		label: "Preferences",
	},
	{
		href: "org/team",
		label: "Team",
	},
	{
		href: "org/audit-logs",
		label: "Audit Logs",
	},
] as const;

// TOOLS_RESOURCES will be created dynamically inside the component

const USER_MENU_ITEMS = [
	{
		href: "settings/account",
		label: "Account",
		icon: UserIcon,
	},
	{
		href: "settings/security",
		label: "Security",
		icon: Shield,
	},
] as const;

interface DashboardSidebarProps {
	organizations: Organization[];
	onSelectOrganization: (org: Organization | null) => void;
	onOrganizationCreated: (org: Organization) => void;
	selectedOrganization: Organization | null;
}

// Sub-components
function DashboardSidebarHeader({
	organizations,
	selectedOrganization,
	onSelectOrganization,
	onOrganizationCreated,
}: {
	organizations: Organization[];
	selectedOrganization: Organization | null;
	onSelectOrganization: (org: Organization | null) => void;
	onOrganizationCreated: (org: Organization) => void;
}) {
	const { buildUrl } = useDashboardNavigation();

	return (
		<SidebarHeader>
			<SidebarMenu>
				<SidebarMenuItem>
					<SidebarMenuButton size="lg" asChild tooltip="LLM Gateway">
						<Link href={buildUrl()} prefetch={true}>
							<div className="flex aspect-square size-8 items-center justify-center">
								<Logo className="size-6 text-black dark:text-white" />
							</div>
							<span className="text-lg font-bold tracking-tight">
								LLM Gateway
							</span>
						</Link>
					</SidebarMenuButton>
				</SidebarMenuItem>
			</SidebarMenu>
			<div className="group-data-[collapsible=icon]:hidden">
				<OrganizationSwitcher
					organizations={organizations}
					selectedOrganization={selectedOrganization}
					onSelectOrganization={onSelectOrganization}
					onOrganizationCreated={onOrganizationCreated}
				/>
			</div>
		</SidebarHeader>
	);
}

function NavigationItem({
	item,
	isActive,
	onClick,
}: {
	item: (typeof PROJECT_NAVIGATION)[number];
	isActive: (path: string) => boolean;
	onClick: () => void;
}) {
	const { buildUrl } = useDashboardNavigation();
	const href = buildUrl(item.href);
	const [isHovered, setIsHovered] = useState(false);

	return (
		<SidebarMenuItem
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<SidebarMenuButton
				asChild
				isActive={isActive(item.href)}
				tooltip={item.label}
			>
				<Link href={href} onClick={onClick} prefetch={true}>
					<item.icon isHovered={isHovered} />
					<span>{item.label}</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function ProjectSettingsSection({
	isActive,
	isMobile,
	toggleSidebar,
}: {
	isActive: (path: string) => boolean;
	isMobile: boolean;
	toggleSidebar: () => void;
}) {
	const { buildUrl } = useDashboardNavigation();
	const [isHovered, setIsHovered] = useState(false);

	return (
		<SidebarMenuItem
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<SidebarMenuButton
				asChild
				isActive={isActive("settings/preferences")}
				tooltip="Settings"
			>
				<Link
					href={buildUrl("settings/preferences")}
					onClick={() => {
						if (isMobile) {
							toggleSidebar();
						}
					}}
					prefetch={true}
				>
					<AnimatedSettings isHovered={isHovered} />
					<span>Settings</span>
				</Link>
			</SidebarMenuButton>
			<SidebarMenuSub className="ml-7">
				{PROJECT_SETTINGS.map((item) => (
					<SidebarMenuSubItem key={item.href}>
						<SidebarMenuSubButton asChild isActive={isActive(item.href)}>
							<Link
								href={buildUrl(item.href)}
								onClick={() => {
									if (isMobile) {
										toggleSidebar();
									}
								}}
								prefetch={true}
							>
								<span>{item.label}</span>
							</Link>
						</SidebarMenuSubButton>
					</SidebarMenuSubItem>
				))}
			</SidebarMenuSub>
		</SidebarMenuItem>
	);
}

function OrgNavItem({
	href,
	label,
	icon: Icon,
	isActive,
	isMobile,
	toggleSidebar,
}: {
	href: string;
	label: string;
	icon: AnimatedIconComponent;
	isActive: boolean;
	isMobile: boolean;
	toggleSidebar: () => void;
}) {
	const [isHovered, setIsHovered] = useState(false);

	return (
		<SidebarMenuItem
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<SidebarMenuButton asChild isActive={isActive} tooltip={label}>
				<Link
					href={href as Route}
					onClick={() => {
						if (isMobile) {
							toggleSidebar();
						}
					}}
					prefetch={true}
				>
					<Icon isHovered={isHovered} />
					<span>{label}</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function OrganizationSection({
	isActive,
	isMobile,
	toggleSidebar,
	searchParams,
}: {
	isActive: (path: string) => boolean;
	isMobile: boolean;
	toggleSidebar: () => void;
	searchParams: ReadonlyURLSearchParams;
}) {
	const { buildOrgUrl } = useDashboardNavigation();
	const [settingsHovered, setSettingsHovered] = useState(false);

	return (
		<SidebarGroup>
			<SidebarGroupLabel className="text-muted-foreground px-2 text-xs font-medium">
				Organization
			</SidebarGroupLabel>
			<SidebarGroupContent className="mt-2">
				<SidebarMenu>
					<OrgNavItem
						href={buildOrgUrl("org/provider-keys")}
						label="Provider Keys"
						icon={AnimatedKeyRound}
						isActive={isActive("org/provider-keys")}
						isMobile={isMobile}
						toggleSidebar={toggleSidebar}
					/>
					<OrgNavItem
						href={buildOrgUrl("org/guardrails")}
						label="Guardrails"
						icon={AnimatedShield}
						isActive={isActive("org/guardrails")}
						isMobile={isMobile}
						toggleSidebar={toggleSidebar}
					/>
					<OrgNavItem
						href={buildOrgUrl("org/security-events")}
						label="Security Events"
						icon={AnimatedShieldAlert}
						isActive={isActive("org/security-events")}
						isMobile={isMobile}
						toggleSidebar={toggleSidebar}
					/>
					<OrgNavItem
						href={buildOrgUrl("org/discounts")}
						label="Your Discounts"
						icon={AnimatedPercent}
						isActive={isActive("org/discounts")}
						isMobile={isMobile}
						toggleSidebar={toggleSidebar}
					/>
					<SidebarMenuItem
						onMouseEnter={() => setSettingsHovered(true)}
						onMouseLeave={() => setSettingsHovered(false)}
					>
						<SidebarMenuButton
							asChild
							isActive={
								isActive("org/billing") ||
								isActive("org/transactions") ||
								isActive("org/referrals") ||
								isActive("org/policies") ||
								isActive("org/preferences") ||
								isActive("org/team") ||
								isActive("org/audit-logs")
							}
							tooltip="Settings"
						>
							<Link
								href={buildOrgUrl("org/billing")}
								onClick={() => {
									if (isMobile) {
										toggleSidebar();
									}
								}}
								prefetch={true}
							>
								<AnimatedSettings isHovered={settingsHovered} />
								<span>Settings</span>
							</Link>
						</SidebarMenuButton>
						<SidebarMenuSub className="ml-7">
							{ORGANIZATION_SETTINGS.map((item) => (
								<SidebarMenuSubItem key={item.href}>
									<SidebarMenuSubButton asChild isActive={isActive(item.href)}>
										<Link
											href={buildOrgUrl(item.href)}
											onClick={() => {
												if (isMobile) {
													toggleSidebar();
												}
											}}
											prefetch={true}
										>
											<span>{item.label}</span>
										</Link>
									</SidebarMenuSubButton>
								</SidebarMenuSubItem>
							))}
						</SidebarMenuSub>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function ToolsResourceItem({
	item,
	isActive,
	isMobile,
	toggleSidebar,
}: {
	item: {
		href: string;
		label: string;
		icon: AnimatedIconComponent;
		internal: boolean;
	};
	isActive: (path: string) => boolean;
	isMobile: boolean;
	toggleSidebar: () => void;
}) {
	const [isHovered, setIsHovered] = useState(false);

	return (
		<SidebarMenuItem
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{item.internal ? (
				<SidebarMenuButton
					asChild
					isActive={isActive(item.href)}
					tooltip={item.label}
				>
					<Link
						href={item.href as Route}
						onClick={() => {
							if (isMobile) {
								toggleSidebar();
							}
						}}
						prefetch={true}
					>
						<item.icon isHovered={isHovered} />
						<span>{item.label}</span>
					</Link>
				</SidebarMenuButton>
			) : (
				<SidebarMenuButton asChild tooltip={item.label}>
					<a
						href={item.href}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => {
							if (isMobile) {
								toggleSidebar();
							}
						}}
					>
						<item.icon isHovered={isHovered} />
						<span>{item.label}</span>
						<ExternalLink className="ml-auto h-3 w-3 group-data-[collapsible=icon]:hidden" />
					</a>
				</SidebarMenuButton>
			)}
		</SidebarMenuItem>
	);
}

function ToolsResourcesSection({
	toolsResources,
	isActive,
	isMobile,
	toggleSidebar,
}: {
	toolsResources: readonly {
		href: string;
		label: string;
		icon: AnimatedIconComponent;
		internal: boolean;
	}[];
	isActive: (path: string) => boolean;
	isMobile: boolean;
	toggleSidebar: () => void;
}) {
	return (
		<SidebarGroup>
			<SidebarGroupLabel className="text-muted-foreground px-2 text-xs font-medium">
				Tools & Resources
			</SidebarGroupLabel>
			<SidebarGroupContent className="mt-2">
				<SidebarMenu>
					{toolsResources.map((item) => (
						<ToolsResourceItem
							key={item.href}
							item={item}
							isActive={isActive}
							isMobile={isMobile}
							toggleSidebar={toggleSidebar}
						/>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

function ThemeSelect() {
	const { theme, setTheme } = useTheme();

	return (
		<Select value={theme} onValueChange={setTheme}>
			<SelectTrigger className="w-full">
				<SelectValue placeholder="Select theme" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="light">
					<div className="flex items-center">
						<SunIcon className="mr-2 h-4 w-4" />
						Light
					</div>
				</SelectItem>
				<SelectItem value="dark">
					<div className="flex items-center">
						<MoonIcon className="mr-2 h-4 w-4" />
						Dark
					</div>
				</SelectItem>
				<SelectItem value="system">
					<div className="flex items-center">
						<ComputerIcon className="mr-2 h-4 w-4" />
						System
					</div>
				</SelectItem>
			</SelectContent>
		</Select>
	);
}

function UserDropdownMenu({
	user,
	isMobile,
	toggleSidebar,
	onLogout,
}: {
	user: User;
	isMobile: boolean;
	toggleSidebar: () => void;
	onLogout: () => void;
}) {
	const { buildUrl } = useDashboardNavigation();
	const searchParams = useSearchParams();

	const getUserInitials = () => {
		if (!user?.name) {
			return "U";
		}
		return user.name
			.split(" ")
			.map((n: string) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<SidebarMenuButton
					size="lg"
					className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
						<span className="text-xs font-semibold">{getUserInitials()}</span>
					</div>
					<div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
						<span className="truncate font-semibold">{user?.name}</span>
						<span className="truncate text-xs text-muted-foreground">
							{user?.email}
						</span>
					</div>
					<ChevronUp className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
				</SidebarMenuButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
				side="top"
				align="end"
				sideOffset={4}
			>
				<div className="p-2">
					<ThemeSelect />
				</div>
				<DropdownMenuSeparator />
				{USER_MENU_ITEMS.map((item) => {
					// All user menu items now use buildUrl since we removed billing
					return (
						<DropdownMenuItem key={item.href} asChild>
							<Link
								href={
									"search" in item
										? (buildUrlWithParams(
												buildUrl(item.href),
												searchParams,
												item.search as Record<string, string | undefined>,
											) as Route)
										: buildUrl(item.href)
								}
								onClick={() => {
									if (isMobile) {
										toggleSidebar();
									}
								}}
								prefetch={true}
							>
								<item.icon className="mr-2 h-4 w-4" />
								{item.label}
							</Link>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={onLogout}>
					<span>Log out</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function DashboardSidebar({
	organizations,
	onSelectOrganization,
	onOrganizationCreated,
	selectedOrganization,
}: DashboardSidebarProps) {
	const { isMobile, toggleSidebar } = useSidebar();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const router = useRouter();
	const posthog = usePostHog();
	const queryClient = useQueryClient();
	const { signOut } = useAuth();

	const { user } = useUser({
		redirectTo: "/login",
		redirectWhen: "unauthenticated",
	});

	// selectedOrganization is now passed as a prop from the layout

	// Update isActive function to work with new route structure
	const isActive = (path: string) => {
		if (path === "") {
			// For dashboard home, check if we're at the base dashboard route
			return pathname.match(/^\/dashboard\/[^/]+\/[^/]+$/) !== null;
		}
		// For other paths, check if pathname ends with the path
		return pathname.endsWith(`/${path}`);
	};

	const toolsResources = useMemo(
		() => [
			{
				href: "/models",
				label: "Supported Models",
				icon: AnimatedMessageSquare,
				internal: true,
			},
		],
		[],
	);

	const logout = async () => {
		posthog.reset();

		// Clear last used project cookies before signing out
		try {
			await clearLastUsedProjectCookiesAction();
		} catch (error) {
			console.error("Failed to clear last used project cookies:", error);
		}

		await signOut({
			fetchOptions: {
				onSuccess: () => {
					queryClient.clear();
					router.push("/login");
				},
			},
		});
	};

	const handleNavClick = () => {
		if (isMobile) {
			toggleSidebar();
		}
	};

	if (!user) {
		return null;
	}

	return (
		<Sidebar variant="inset" collapsible="icon">
			<DashboardSidebarHeader
				organizations={organizations}
				selectedOrganization={selectedOrganization}
				onSelectOrganization={onSelectOrganization}
				onOrganizationCreated={onOrganizationCreated}
			/>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel className="text-muted-foreground px-2 text-xs font-medium">
						Project
					</SidebarGroupLabel>
					<SidebarGroupContent className="mt-2">
						<SidebarMenu>
							{PROJECT_NAVIGATION.map((item) => (
								<NavigationItem
									key={item.href}
									item={item}
									isActive={isActive}
									onClick={handleNavClick}
								/>
							))}
							<ProjectSettingsSection
								isActive={isActive}
								isMobile={isMobile}
								toggleSidebar={toggleSidebar}
							/>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				<OrganizationSection
					isActive={isActive}
					isMobile={isMobile}
					toggleSidebar={toggleSidebar}
					searchParams={searchParams}
				/>

				<ToolsResourcesSection
					toolsResources={toolsResources}
					isActive={isActive}
					isMobile={isMobile}
					toggleSidebar={toggleSidebar}
				/>
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<UserDropdownMenu
							user={user}
							isMobile={isMobile}
							toggleSidebar={toggleSidebar}
							onLogout={logout}
						/>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
