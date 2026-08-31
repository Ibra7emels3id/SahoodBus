import { startLogin } from "@/const";
import {
  BarChart3,
  BusFront,
  ChevronDown,
  ClipboardList,
  Coins,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Settings,
  Smartphone,
  UsersRound,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";

export type ViewId = "dashboard" | "trips" | "reservations" | "customers" | "cashbox" | "expenses" | "reports" | "users" | "whatsapp";

type LayoutProps = {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  userMode: "admin" | "branch";
  onChangeMode: (mode: "admin" | "branch") => void;
  children: React.ReactNode;
};

const navItems: Array<{ id: ViewId; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean; permission?: "bookings" | "edit_prices" | "cashbox" | "reports" | "exports" }> = [
  { id: "dashboard", label: "لوحة المتابعة", icon: LayoutDashboard, adminOnly: true },
  { id: "trips", label: "الرحلات", icon: BusFront },
  { id: "reservations", label: "الحجوزات", icon: ClipboardList, permission: "bookings" },
  { id: "customers", label: "حجز خارجي", icon: UsersRound, permission: "bookings" },
  { id: "cashbox", label: "الخزنة", icon: Coins, permission: "cashbox" },
  { id: "expenses", label: "المصروفات", icon: ReceiptText, permission: "cashbox" },
  { id: "reports", label: "التقارير", icon: BarChart3, permission: "reports" },
  { id: "users", label: "المستخدمون", icon: Settings, adminOnly: true },
  { id: "whatsapp", label: "واتساب والرسائل", icon: Smartphone, adminOnly: true },
];

export default function DashboardLayout({ activeView, onNavigate, userMode, onChangeMode, children }: LayoutProps) {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const canUseLiveAuth = Boolean(user);
  const isAdmin = user ? user.role === "admin" : userMode === "admin";
  const userPermissions = user?.permissions ?? ["bookings", "cashbox", "reports", "exports"];
  const displayedName = user?.name || (isAdmin ? "مدير النظام" : "مستخدم فرع");
  const displayedBranchName = !isAdmin ? user?.branchName ?? "فرع غير مرتبط" : null;
  const displayedRole = isAdmin ? "مدير النظام" : `مستخدم فرع · ${displayedBranchName}`;

  const navigation = (
    <nav className="flex h-full flex-col" aria-label="التنقل الرئيسي">
      <div className="px-5 pb-7 pt-7">
        <div className="brand-mark" aria-label="حافلة سهود">
          <div className="brand-icon"><BusFront size={22} strokeWidth={2.3} /></div>
          <div>
            <p className="text-[10px] font-semibold tracking-[0.22em] text-white/55">SUHOUD BUS</p>
            <p className="mt-1 text-lg font-extrabold tracking-tight text-white">حافلة سهود</p>
          </div>
        </div>
        <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.06] px-3 py-3">
          <p className="text-[10px] font-medium text-white/55">بيئة العمل</p>
          <div className="mt-2 flex items-center justify-between gap-2 text-sm text-white">
            <span>{isAdmin ? "مكتب الحجوزات" : displayedBranchName}</span>
            <span className="status-dot" />
          </div>
        </div>
      </div>

      <div className="sidebar-scroll px-3">
        <p className="px-3 pb-2 text-[10px] font-semibold tracking-[0.12em] text-white/40">القائمة الرئيسية</p>
        <div className="space-y-1">
          {navItems.filter(item => (!item.adminOnly || isAdmin) && (!item.permission || isAdmin || userPermissions.includes(item.permission))).map(item => {
            const Icon = item.icon;
            const isActive = item.id === activeView;
            return (
              <button
                key={item.id}
                onClick={() => { onNavigate(item.id); setIsOpen(false); }}
                className={`sidebar-link ${isActive ? "sidebar-link-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={18} strokeWidth={isActive ? 2.5 : 2} />
                <span>{item.label}</span>
                {item.id === "reservations" && <span className="mr-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] tabular-nums">12</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-auto border-t border-white/10 p-4">
        <div className="rounded-2xl bg-white/[0.07] p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e7ac67] text-sm font-extrabold text-[#173f38]">
              {displayedName.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-white">{displayedName}</p>
              <p className="mt-1 truncate text-[10px] text-white/55">{displayedRole}</p>
            </div>
            {canUseLiveAuth ? <button onClick={logout} className="text-white/55 transition hover:text-white" title="تسجيل الخروج"><LogOut size={16} /></button> : <button onClick={startLogin} className="text-white/55 transition hover:text-white" title="تسجيل الدخول"><LogOut size={16} /></button>}
          </div>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="app-shell" dir="rtl">
      <aside className="desktop-sidebar">{navigation}</aside>
      {isOpen && <button className="mobile-scrim" aria-label="إغلاق القائمة" onClick={() => setIsOpen(false)} />}
      <aside className={`mobile-sidebar ${isOpen ? "mobile-sidebar-open" : ""}`}>
        <button className="mobile-close" onClick={() => setIsOpen(false)} aria-label="إغلاق القائمة"><X size={20} /></button>
        {navigation}
      </aside>

      <main className="app-main">
        <header className="app-header">
          <button className="mobile-menu" onClick={() => setIsOpen(true)} aria-label="فتح القائمة"><Menu size={21} /></button>
          <div className="hidden min-w-0 sm:block">
            <p className="text-xs font-medium text-[#7a8b87]">الخميس، 24 أغسطس 2026</p>
            <p className="mt-1 text-sm font-semibold text-[#173f38]">أهلاً بك، {displayedName}</p>
          </div>
          <div className="mr-auto flex items-center gap-2 sm:gap-3">
            {!canUseLiveAuth && <button className="action-primary hidden sm:inline-flex" onClick={startLogin}>تسجيل الدخول للحفظ</button>}
            {!canUseLiveAuth && <label className="mode-picker">
              <span className="hidden text-xs text-[#6e807c] sm:inline">عرض النظام:</span>
              <select value={userMode} onChange={event => onChangeMode(event.target.value as "admin" | "branch")} aria-label="تغيير منظور المستخدم">
                <option value="admin">الإدارة</option>
                <option value="branch">فرع العزيزية</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>}
            <button className="header-icon" aria-label="الإشعارات">
              <span className="notification-ping" />
              <CreditCard size={19} />
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
