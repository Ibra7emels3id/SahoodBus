import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import {
  Building2,
  Download,
  MessageCircle,
  Plus,
  Printer,
  TicketCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { calculateExternalOfficeRevenue } from "../../../shared/bookingFinancials";

const number = (value: unknown) =>
  new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(
    Number(value ?? 0)
  );
const displayDate = (value: unknown) => {
  if (!value) return "غير محدد";
  const date = new Date(value as Date);
  return Number.isNaN(date.valueOf())
    ? String(value)
    : date.toLocaleDateString("ar-SA", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
};

type ExternalBookingRow = {
  externalBookingCode: string;
  routeName: string;
  travelDate?: string;
  externalOfficeName: string;
  passengerName: string;
  phone: string;
  nationality: string;
  passportNumber: string;
  birthDate?: string;
  luggageCount: number;
  passengerType: string;
  paymentMethod: string;
  ticketPrice: number;
  externalOfficeFee: number;
  officeRevenue: number;
  branchId?: number;
  createdAt: Date;
  branchContactPhone?: string | null;
};

function printExternalTicket(item: ExternalBookingRow) {
  const ticketWindow = window.open("", "_blank", "width=760,height=760");
  if (!ticketWindow) {
    toast.error(
      "تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة."
    );
    return;
  }
  ticketWindow.document.write(
    `<!doctype html><html dir="rtl" lang="ar"><head><title>تذكرة خارجية ${item.externalBookingCode}</title><style>body{font-family:Arial,sans-serif;margin:36px;color:#173f38}.ticket{border:2px solid #173f38;border-radius:16px;overflow:hidden}.head{background:#173f38;color:#fff;padding:24px}.head h1{margin:0;font-size:25px}.head p{margin:8px 0 0;color:#d4e8dc}.body{padding:24px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.item{border-bottom:1px solid #e5ece7;padding-bottom:10px}.label{font-size:12px;color:#71837d}.value{font-weight:700;margin-top:5px}.financial{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:22px;background:#f2faf4;padding:16px;border-radius:10px}.financial .label{font-size:11px}@media print{body{margin:0}}</style></head><body><section class="ticket"><header class="head"><h1>حافلة سهود</h1><p>تذكرة حجز خارجي · ${item.externalBookingCode}</p></header><main class="body"><div class="grid"><div class="item"><div class="label">اسم المسافر</div><div class="value">${item.passengerName}</div></div><div class="item"><div class="label">رقم الهاتف</div><div class="value">${item.phone}</div></div><div class="item"><div class="label">المسار</div><div class="value">${item.routeName}</div></div><div class="item"><div class="label">تاريخ السفر</div><div class="value">${displayDate(item.travelDate)}</div></div><div class="item"><div class="label">المكتب الخارجي</div><div class="value">${item.externalOfficeName}</div></div>${item.branchContactPhone ? `<div class="item"><div class="label">تواصل الفرع</div><div class="value" dir="ltr">${item.branchContactPhone}</div></div>` : ""}<div class="item"><div class="label">رقم الجواز</div><div class="value">${item.passportNumber}</div></div></div><div class="financial"><div><div class="label">سعر التذكرة</div><div class="value">${number(item.ticketPrice)} ر.س</div></div><div><div class="label">رسوم المكتب الخارجي</div><div class="value">${number(item.externalOfficeFee)} ر.س</div></div><div><div class="label">صافي إيراد سهود</div><div class="value">${number(item.officeRevenue)} ر.س</div></div></div></main></section><script>window.print()</script></body></html>`
  );
  ticketWindow.document.close();
}

export default function ExternalBookingsPage() {
  const { user } = useAuth();
  const isBranchUser = user?.role === "user";
  const utils = trpc.useUtils();
  const bookingsQuery = trpc.mongoBooking.externalBookings.list.useQuery(
    undefined,
    { retry: false, refetchOnWindowFocus: false }
  );
  const frequentCustomers = trpc.mongoBooking.customers.frequent.useQuery(
    undefined,
    { retry: false, refetchOnWindowFocus: false }
  );
  const whatsappMessages = trpc.mongoBooking.whatsapp.messages.useQuery(
    undefined,
    { refetchInterval: 10_000 }
  );
  const sendWhatsapp = trpc.mongoBooking.whatsapp.manualLink.useMutation({
    onSuccess: result => {
      window.open(result.url, "_blank", "noopener,noreferrer");
      toast.success(
        "فُتحت محادثة واتساب برسالة الحجز الجاهزة. اضغط إرسال من واتساب لتأكيد الإرسال."
      );
      void whatsappMessages.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const branchesQuery = trpc.mongoBooking.admin.branches.list.useQuery(
    undefined,
    { enabled: !isBranchUser, retry: false, refetchOnWindowFocus: false }
  );
  const [isModalOpen, setModalOpen] = useState(false);
  const bookings = (bookingsQuery.data ??
    []) as unknown as ExternalBookingRow[];
  const totals = useMemo(
    () =>
      bookings.reduce(
        (result, item) => ({
          gross: result.gross + Number(item.ticketPrice),
          fees: result.fees + Number(item.externalOfficeFee),
          revenue: result.revenue + Number(item.officeRevenue),
        }),
        { gross: 0, fees: 0, revenue: 0 }
      ),
    [bookings]
  );
  const whatsappCounts = useMemo(
    () =>
      (whatsappMessages.data ?? []).reduce<Record<string, number>>(
        (result, item) => {
          if (item.bookingType === "external")
            result[String(item.bookingCode)] =
              (result[String(item.bookingCode)] ?? 0) + 1;
          return result;
        },
        {}
      ),
    [whatsappMessages.data]
  );

  return (
    <>
      <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-kicker">تذاكر من مكاتب أخرى</p>
          <h1 className="page-title">حجز خارجي</h1>
          <p className="page-subtitle">
            أصدر تذكرة للعميل بدون ربطها برحلة أو حافلة سهود، وسجّل رسوم المكتب
            الخارجي وصافي الإيراد.
          </p>
        </div>
        <button className="action-primary" onClick={() => setModalOpen(true)}>
          <Plus size={16} /> إضافة حجز خارجي
        </button>
      </div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="قيمة التذاكر الخارجية"
          value={totals.gross}
          tone="blue"
        />
        <SummaryCard
          label="رسوم المكاتب الخارجية"
          value={totals.fees}
          tone="amber"
        />
        <SummaryCard
          label="صافي إيراد سهود"
          value={totals.revenue}
          tone="green"
        />
      </div>
      <section className="soft-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#edf0ed] p-5">
          <div>
            <h2 className="section-title">سجل الحجوزات الخارجية</h2>
            <p className="mt-1 section-meta">
              لا يحتوي هذا السجل على حافلة أو مقعد أو رحلة داخلية.
            </p>
          </div>
          <span className="text-[11px] font-bold text-[#2d7a60]">
            {number(bookings.length)} تذاكر
          </span>
        </div>
        {bookingsQuery.isLoading ? (
          <div className="p-10 text-center text-[11px] text-[#81938d]">
            جارٍ تحميل الحجوزات الخارجية من MongoDB.
          </div>
        ) : bookings.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>رقم التذكرة</th>
                  <th>المسافر</th>
                  <th>المسار / التاريخ</th>
                  <th>المكتب الخارجي</th>
                  <th>السعر</th>
                  <th>رسوم المكتب</th>
                  <th>صافي سهود</th>
                  <th>الدفع</th>
                  <th>واتساب</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bookings.map(item => (
                  <tr key={item.externalBookingCode}>
                    <td className="font-bold text-[#406f9c]">
                      {item.externalBookingCode}
                    </td>
                    <td>
                      <p className="font-semibold">{item.passengerName}</p>
                      <p className="mt-1 text-[9px] text-[#92a09c]" dir="ltr">
                        {item.phone}
                      </p>
                    </td>
                    <td>
                      <p>{item.routeName}</p>
                      <p className="mt-1 text-[9px] text-[#82958e]">
                        {displayDate(item.travelDate)}
                      </p>
                    </td>
                    <td>{item.externalOfficeName}</td>
                    <td>{number(item.ticketPrice)} ر.س</td>
                    <td className="text-[#a36b22]">
                      {number(item.externalOfficeFee)} ر.س
                    </td>
                    <td className="font-extrabold text-[#287a5d]">
                      {number(item.officeRevenue)} ر.س
                    </td>
                    <td>{item.paymentMethod}</td>
                    <td>
                      <button
                        className="table-action"
                        title="إرسال تفاصيل الحجز عبر واتساب"
                        onClick={() => {
                          if (
                            window.confirm(
                              `إرسال تفاصيل الحجز ${item.externalBookingCode} عبر واتساب الآن؟`
                            )
                          )
                            sendWhatsapp.mutate({
                              bookingType: "external",
                              bookingCode: item.externalBookingCode,
                            });
                        }}
                      >
                        <MessageCircle size={15} />
                      </button>
                      <span className="mr-1 text-[10px] text-[#71827e]">
                        {whatsappCounts[item.externalBookingCode] ?? 0}
                      </span>
                    </td>
                    <td>
                      <button
                        className="table-action table-print"
                        title="طباعة التذكرة"
                        onClick={() => printExternalTicket(item)}
                      >
                        <Printer size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center">
            <Building2 className="mx-auto text-[#80a095]" size={32} />
            <h2 className="mt-4 text-sm font-extrabold text-[#284f45]">
              لا توجد تذاكر خارجية حتى الآن
            </h2>
            <p className="mt-2 text-[11px] text-[#7e908a]">
              أضف أول تذكرة من مكتب خارجي؛ لن تحتاج إلى إدخال أي بيانات حافلة أو
              مقعد.
            </p>
            <button
              className="action-primary mt-5"
              onClick={() => setModalOpen(true)}
            >
              <Plus size={15} /> إضافة حجز خارجي
            </button>
          </div>
        )}
      </section>
      <section className="soft-card mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#edf0ed] p-5">
          <div>
            <h2 className="section-title">العملاء المتكررون</h2>
            <p className="mt-1 section-meta">
              يُجمع تلقائياً من حجوزات الفرع الداخلية والخارجية لتسريع إدخال
              البيانات.
            </p>
          </div>
          <span className="rounded-full bg-[#edf6f0] px-3 py-1 text-[10px] font-bold text-[#2d7a60]">
            {frequentCustomers.data?.length ?? 0} عميل
          </span>
        </div>
        {frequentCustomers.data?.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>الهاتف</th>
                  <th>الجنسية</th>
                  <th>عدد الحجوزات</th>
                  <th>آخر حجز</th>
                </tr>
              </thead>
              <tbody>
                {frequentCustomers.data.map(customer => (
                  <tr key={customer.phone}>
                    <td className="font-bold">{customer.passengerName}</td>
                    <td dir="ltr">{customer.phone}</td>
                    <td>{customer.nationality || "—"}</td>
                    <td>
                      <span className="rounded-lg bg-[#e9f5ee] px-2 py-1 font-bold text-[#287a5d]">
                        {customer.bookingCount}
                      </span>
                    </td>
                    <td>{displayDate(customer.lastBookedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-7 text-center text-[11px] text-[#81938d]">
            تظهر هنا بيانات العملاء بعد تسجيل الحجوزات الأولى.
          </div>
        )}
      </section>
      {isModalOpen && (
        <ExternalBookingModal
          isBranchUser={isBranchUser}
          branches={(branchesQuery.data ?? []).map(branch => ({
            id: Number(branch.id),
            name: String(branch.name),
          }))}
          onClose={() => setModalOpen(false)}
          onSuccess={() => {
            utils.mongoBooking.externalBookings.list.invalidate();
            utils.mongoBooking.cashbox.overview.invalidate();
            utils.mongoBooking.reports.overview.invalidate();
            setModalOpen(false);
          }}
        />
      )}
    </>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "amber" | "green";
}) {
  const palette = {
    blue: "bg-[#edf5fb] text-[#31719b]",
    amber: "bg-[#fff5e5] text-[#a36b22]",
    green: "bg-[#eaf6ee] text-[#27775a]",
  }[tone];
  return (
    <div className="soft-card p-5">
      <span
        className={`inline-grid h-10 w-10 place-items-center rounded-xl ${palette}`}
      >
        <TicketCheck size={18} />
      </span>
      <p className="mt-5 text-2xl font-extrabold tracking-[-.06em] text-[#173f38]">
        {number(value)} <span className="text-xs tracking-normal">ر.س</span>
      </p>
      <p className="mt-2 text-[11px] text-[#71847e]">{label}</p>
    </div>
  );
}

function ExternalBookingModal({
  isBranchUser,
  branches,
  onClose,
  onSuccess,
}: {
  isBranchUser: boolean;
  branches: Array<{ id: number; name: string }>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    routeName: "",
    travelDate: "",
    externalOfficeName: "",
    passengerName: "",
    phone: "",
    nationality: "",
    passportNumber: "",
    birthDate: "",
    luggageCount: "0",
    passengerType: "بالغ" as "بالغ" | "طفل",
    paymentMethod: "نقدي" as "نقدي" | "شبكة",
    ticketPrice: "",
    externalOfficeFee: "",
    branchId: "",
  });
  const update = (key: keyof typeof form, value: string) =>
    setForm(current => ({ ...current, [key]: value }));
  const financials = calculateExternalOfficeRevenue(
    Number(form.ticketPrice),
    Number(form.externalOfficeFee)
  );
  const create = trpc.mongoBooking.externalBookings.create.useMutation({
    onSuccess: result => {
      toast.success(
        `تم حفظ الحجز الخارجي ${result.externalBookingCode} وصافي المكتب ${number(result.officeRevenue)} ر.س.`
      );
      onSuccess();
    },
    onError: error => toast.error(error.message),
  });
  const canSave =
    financials.valid &&
    form.routeName.trim() &&
    form.externalOfficeName.trim() &&
    form.passengerName.trim() &&
    form.phone.trim() &&
    form.nationality.trim() &&
    form.passportNumber.trim() &&
    Number(form.ticketPrice) >= 0 &&
    Number(form.externalOfficeFee) >= 0;
  const save = () =>
    create.mutate({
      routeName: form.routeName.trim(),
      ...(form.travelDate ? { travelDate: form.travelDate } : {}),
      externalOfficeName: form.externalOfficeName.trim(),
      passengerName: form.passengerName.trim(),
      phone: form.phone.trim(),
      nationality: form.nationality.trim(),
      passportNumber: form.passportNumber.trim(),
      ...(form.birthDate ? { birthDate: form.birthDate } : {}),
      luggageCount: Number(form.luggageCount || 0),
      passengerType: form.passengerType,
      paymentMethod: form.paymentMethod,
      ticketPrice: Number(form.ticketPrice),
      externalOfficeFee: Number(form.externalOfficeFee),
      ...(!isBranchUser && form.branchId
        ? { branchId: Number(form.branchId) }
        : {}),
    });
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="external-booking-title"
    >
      <div className="modal-card">
        <div className="flex items-center justify-between border-b border-[#edf0ed] px-6 py-5">
          <div>
            <p className="page-kicker">بدون رحلة أو حافلة سهود</p>
            <h2
              id="external-booking-title"
              className="mt-1 text-lg font-extrabold text-[#173f38]"
            >
              إضافة حجز خارجي
            </h2>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-[#789087] hover:bg-[#f3f6f3]"
            onClick={onClose}
            aria-label="إغلاق"
          >
            <X size={19} />
          </button>
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-2">
          <FormInput
            label="اسم المسافر"
            value={form.passengerName}
            onChange={value => update("passengerName", value)}
            placeholder="اسم المسافر"
          />
          <FormInput
            label="رقم الهاتف"
            value={form.phone}
            onChange={value => update("phone", value)}
            placeholder="05XXXXXXXX"
            direction="ltr"
          />
          <FormInput
            label="الجنسية"
            value={form.nationality}
            onChange={value => update("nationality", value)}
            placeholder="الجنسية"
          />
          <FormInput
            label="رقم الجواز"
            value={form.passportNumber}
            onChange={value => update("passportNumber", value)}
            placeholder="رقم الجواز"
            direction="ltr"
          />
          <FormInput
            label="المسار"
            value={form.routeName}
            onChange={value => update("routeName", value)}
            placeholder="مثال: الرياض ← القاهرة"
          />
          <FormInput
            label="تاريخ السفر"
            value={form.travelDate}
            onChange={value => update("travelDate", value)}
            type="date"
          />
          <FormInput
            label="المكتب الخارجي"
            value={form.externalOfficeName}
            onChange={value => update("externalOfficeName", value)}
            placeholder="اسم المكتب أو الناقل"
          />
          <FormInput
            label="تاريخ الميلاد"
            value={form.birthDate}
            onChange={value => update("birthDate", value)}
            type="date"
          />
          <FormInput
            label="عدد الشنط"
            value={form.luggageCount}
            onChange={value => update("luggageCount", value)}
            type="number"
          />
          <FormSelect
            label="نوع المسافر"
            value={form.passengerType}
            onChange={value => update("passengerType", value)}
            options={["بالغ", "طفل"]}
          />
          <FormSelect
            label="طريقة الدفع"
            value={form.paymentMethod}
            onChange={value => update("paymentMethod", value)}
            options={["نقدي", "شبكة"]}
          />
          {!isBranchUser && (
            <FormSelect
              label="فرع الحجز"
              value={form.branchId}
              onChange={value => update("branchId", value)}
              options={["", ...branches.map(branch => String(branch.id))]}
              optionLabels={[
                "غير مرتبط بفرع",
                ...branches.map(branch => branch.name),
              ]}
            />
          )}
          <FormInput
            label="سعر التذكرة"
            value={form.ticketPrice}
            onChange={value => update("ticketPrice", value)}
            type="number"
          />
          <FormInput
            label="رسوم المكتب الخارجي"
            value={form.externalOfficeFee}
            onChange={value => update("externalOfficeFee", value)}
            type="number"
          />
          <label className="block text-[10px] font-bold text-[#4e6860] sm:col-span-2">
            صافي إيراد سهود
            <input
              className="input-control mt-2 border-[#9ac8b0] bg-[#f2faf4] font-extrabold text-[#287a5d]"
              value={`${financials.valid ? number(financials.officeRevenue) : "0"} ر.س`}
              readOnly
            />
          </label>
          <div className="sm:col-span-2 rounded-xl bg-[#f7faf7] px-4 py-3 text-[10px] text-[#637a72]">
            المعادلة:{" "}
            <strong className="text-[#245f4e]">
              سعر التذكرة − رسوم المكتب الخارجي = صافي إيراد سهود
            </strong>
            . لا تُسجل أي حافلة أو مقعد في هذا النوع من الحجوزات.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#edf0ed] px-6 py-4">
          <button className="action-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="action-primary"
            disabled={!canSave || create.isPending}
            onClick={save}
          >
            <Download size={15} /> حفظ التذكرة الخارجية
          </button>
        </div>
      </div>
    </div>
  );
}

function FormInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  direction,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  direction?: "ltr" | "rtl";
}) {
  return (
    <label className="block text-[10px] font-bold text-[#4e6860]">
      {label}
      <input
        className="input-control mt-2"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        dir={direction}
      />
    </label>
  );
}

function FormSelect({
  label,
  value,
  onChange,
  options,
  optionLabels,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  optionLabels?: string[];
}) {
  return (
    <label className="block text-[10px] font-bold text-[#4e6860]">
      {label}
      <select
        className="input-control mt-2"
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {options.map((item, index) => (
          <option key={item || "empty"} value={item}>
            {optionLabels?.[index] ?? item}
          </option>
        ))}
      </select>
    </label>
  );
}
