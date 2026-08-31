import { CheckCircle2, Clock3, RefreshCw, Smartphone, Wifi, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

const statusLabels: Record<string, string> = {
  connected: "متصل وجاهز للإرسال",
  connecting: "جارٍ الاتصال",
  need_scan: "بانتظار مسح QR",
  need_passkey: "بانتظار مفتاح المرور",
  disconnected: "غير متصل",
  logged_out: "تم تسجيل الخروج",
  expired: "انتهت الجلسة",
  unknown: "غير معروف",
};

const messageStatusLabels: Record<string, string> = {
  pending: "بانتظار الإرسال",
  in_progress: "قيد الإرسال",
  sent: "تم الإرسال",
  delivered: "تم التسليم",
  read: "تمت القراءة",
  played: "تم التشغيل",
  failed: "فشل الإرسال",
  rate_limited: "حد التجربة المؤقت",
  manual_link_opened: "فُتحت محادثة يدوية",
  not_configured: "لا توجد جلسة نشطة",
};

const messageCategoryLabels: Record<string, string> = {
  booking: "تفاصيل حجز",
  trip_reminder: "تذكير رحلة",
  feedback_request: "متابعة رضا",
  feedback_review: "رابط تقييم",
  feedback_ack: "رد اعتذار",
  manual_retry: "إعادة إرسال إدارية",
  password_reset: "استعادة كلمة المرور",
};

const normalizeStoredMessageStatus = (status: unknown) => ({ "0": "failed", "1": "pending", "2": "sent", "3": "delivered", "4": "read", "5": "played" } as Record<string, string>)[String(status ?? "")] ?? String(status ?? "unknown");

export default function WhatsAppSettingsPage() {
  const utils = trpc.useUtils();
  const config = trpc.mongoBooking.admin.whatsapp.config.useQuery();
  const [messageStatusFilter, setMessageStatusFilter] = useState("all");
  const [messageCategoryFilter, setMessageCategoryFilter] = useState("all");
  const messageFilters = messageStatusFilter === "all" && messageCategoryFilter === "all" ? undefined : { ...(messageStatusFilter !== "all" ? { status: messageStatusFilter } : {}), ...(messageCategoryFilter !== "all" ? { category: messageCategoryFilter } : {}) };
  const messages = trpc.mongoBooking.admin.whatsapp.messages.useQuery(messageFilters, { refetchInterval: 10_000 });
  const automationSettings = trpc.mongoBooking.admin.automation.settings.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const customerFeedback = trpc.mongoBooking.admin.automation.feedback.useQuery(undefined, { refetchInterval: 30_000 });
  const createSession = trpc.mongoBooking.admin.whatsapp.createSession.useMutation({
    onSuccess: () => { toast.success("تم إنشاء جلسة واتساب. امسح رمز QR من الهاتف."); void config.refetch(); },
    onError: error => toast.error(error.message),
  });
  const recreateSession = trpc.mongoBooking.admin.whatsapp.recreateSession.useMutation({
    onSuccess: () => { toast.success("تم حفظ الرقم وإنشاء جلسة جديدة. امسح رمز QR من الهاتف."); void config.refetch(); },
    onError: error => toast.error(error.message),
  });
  const refreshStatus = trpc.mongoBooking.admin.whatsapp.refreshStatus.useMutation({
    onSuccess: () => void config.refetch(),
    onError: error => toast.error(error.message),
  });
  const disconnectSession = trpc.mongoBooking.admin.whatsapp.disconnect.useMutation({
    onSuccess: result => { toast.success(result.disconnected ? "تم إنهاء جلسة واتساب وإيقاف الإرسال التلقائي." : result.message); void config.refetch(); void messages.refetch(); },
    onError: error => toast.error(error.message),
  });
  const reconnectSession = trpc.mongoBooking.admin.whatsapp.reconnect.useMutation({
    onSuccess: () => { toast.success("تم إنشاء QR لإعادة ربط الرقم السابق. امسحه من واتساب."); void config.refetch(); },
    onError: error => toast.error(error.message),
  });
  const updateAutomation = trpc.mongoBooking.admin.automation.updateSettings.useMutation({
    onSuccess: () => { toast.success("تم حفظ إعدادات الرسائل التلقائية."); void automationSettings.refetch(); },
    onError: error => toast.error(error.message),
  });
  const retryMessage = trpc.mongoBooking.admin.whatsapp.retry.useMutation({
    onSuccess: result => { toast.success(`تم تسجيل محاولة إعادة الإرسال رقم ${result.attempt}. تابع الحالة في السجل.`); void messages.refetch(); },
    onError: error => toast.error(error.message),
  });

  const [name, setName] = useState("حافلة سهود");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [replacementPhoneNumber, setReplacementPhoneNumber] = useState("");
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [automationForm, setAutomationForm] = useState({ reminderEnabled: true, reminderLeadMinutes: "120", feedbackEnabled: true, feedbackDelayMinutes: "360", googleReviewUrl: "" });
  const [qrImage, setQrImage] = useState<string | null>(null);
  const session = config.data?.session;
  const reconnectableSession = config.data?.reconnectableSession;
  const status = String(session?.status ?? "unknown");

  useEffect(() => {
    if (session?.phoneNumber) setReplacementPhoneNumber(current => current || session.phoneNumber);
  }, [session?.phoneNumber]);
  useEffect(() => {
    const settings = automationSettings.data; if (!settings) return;
    setAutomationForm({ reminderEnabled: settings.reminderEnabled, reminderLeadMinutes: String(settings.reminderLeadMinutes), feedbackEnabled: settings.feedbackEnabled, feedbackDelayMinutes: String(settings.feedbackDelayMinutes), googleReviewUrl: settings.googleReviewUrl ?? "" });
  }, [automationSettings.data]);

  useEffect(() => {
    let cancelled = false;
    if (!session?.qrCode) { setQrImage(null); return; }
    QRCode.toDataURL(session.qrCode, { width: 300, margin: 2 })
      .then(value => { if (!cancelled) setQrImage(value); })
      .catch(() => { if (!cancelled) setQrImage(null); });
    return () => { cancelled = true; };
  }, [session?.qrCode]);

  const waitingForLink = ["need_scan", "connecting", "need_passkey"].includes(status);
  useEffect(() => {
    if (!session || !waitingForLink || refreshStatus.isPending) return;
    const timer = window.setTimeout(() => refreshStatus.mutate(), 4_000);
    return () => window.clearTimeout(timer);
  }, [session?.providerSessionId, waitingForLink, refreshStatus.isPending]);

  const counts = useMemo(() => (messages.data ?? []).reduce<Record<string, number>>((result, item) => {
    const key = normalizeStoredMessageStatus(item.status);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {}), [messages.data]);

  const saveReplacementPhone = () => {
    const phone = replacementPhoneNumber.trim();
    if (phone.length < 7) { toast.error("أدخل رقم واتساب دولياً صحيحاً، مثل +9665xxxxxxxx."); return; }
    if (window.confirm("سيتم استبدال رقم الربط الحالي بالرقم الجديد وإنشاء جلسة QR. هل تريد المتابعة؟")) {
      recreateSession.mutate({ phoneNumber: phone });
    }
  };
  const endSession = () => {
    if (window.confirm("هل تريد إنهاء جلسة واتساب الحالية؟ سيتوقف الإرسال التلقائي فوراً، وستحتاج إلى إنشاء وربط QR جديد قبل الإرسال مرة أخرى.")) disconnectSession.mutate();
  };
  const saveAutomation = () => updateAutomation.mutate({ reminderEnabled: automationForm.reminderEnabled, reminderLeadMinutes: Number(automationForm.reminderLeadMinutes), feedbackEnabled: automationForm.feedbackEnabled, feedbackDelayMinutes: Number(automationForm.feedbackDelayMinutes), googleReviewUrl: automationForm.googleReviewUrl.trim() });

  return <section className="space-y-5" dir="rtl">
    <div className="page-heading"><div><p className="eyebrow">تشغيل ومراقبة الاتصال</p><h1>واتساب والرسائل</h1><p>اربط رقم المكتب بمسح QR من هاتف واتساب، ثم تابع الرسائل من نفس المكان.</p></div><Smartphone size={36} className="text-[#18846f]" /></div>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="surface-card p-5">
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold text-[#173f38]">جلسة واتساب</h2><p className="mt-1 text-sm text-[#748581]">لا يتم عرض أو حفظ Session Token في المتصفح.</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${status === "connected" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{statusLabels[status] ?? status}</span></div>
        {!session && reconnectableSession && !showNewSessionForm ? <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-extrabold text-[#173f38]">جلسة سابقة مفصولة</h3><p className="mt-2 text-sm leading-6 text-[#6b5a36]">الرقم <strong dir="ltr">{reconnectableSession.phoneNumber}</strong> ما زال مسجلاً في Wasender. أعد ربط الجلسة نفسها بالـQR بدلاً من إنشاء جلسة مكررة.</p><div className="mt-4 flex flex-wrap gap-2"><button className="action-primary" onClick={() => reconnectSession.mutate()} disabled={reconnectSession.isPending}>{reconnectSession.isPending ? "جارٍ إنشاء QR..." : "إعادة ربط الرقم السابق بـ QR"}</button><button className="action-secondary" onClick={() => setShowNewSessionForm(true)}>استخدام رقم مختلف</button></div></div> : !session ? <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); createSession.mutate({ name, phoneNumber }); }}>
          <label className="field-label">اسم الجلسة<input className="field-input mt-2" value={name} onChange={event => setName(event.target.value)} required /></label>
          <label className="field-label">رقم واتساب الدولي<input className="field-input mt-2" placeholder="+9665xxxxxxxx" value={phoneNumber} onChange={event => setPhoneNumber(event.target.value)} required /></label>
          <button className="action-primary sm:col-span-2" disabled={createSession.isPending}>{createSession.isPending ? "جارٍ إنشاء الجلسة..." : "إنشاء جلسة وعرض QR"}</button>
        </form> : <div className="mt-6 grid gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:items-start">
          <div className="rounded-3xl border border-[#dce9e4] bg-white p-4 text-center">{qrImage && status !== "connected" ? <img src={qrImage} alt="رمز QR لربط واتساب" className="mx-auto h-[210px] w-[210px]" /> : <div className="grid h-[210px] place-items-center text-sm text-[#71827e]">{status === "connected" ? "تم الربط بنجاح" : "لا يوجد QR حالي"}</div>}<p className="mt-2 text-xs text-[#71827e]">افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p></div>
          <div className="space-y-4 text-sm text-[#526b65]">
            <div><p><strong>الرقم الحالي:</strong> {session.phoneNumber}</p><p className="mt-1"><strong>الحالة:</strong> {statusLabels[status] ?? status}</p><p className="mt-2 text-xs text-[#7a8b87]">بعد مسح QR سيتم تفعيل الإرسال تلقائياً، وستصل تحديثات الحالة إلى سجل الرسائل.</p>{waitingForLink && <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700"><RefreshCw size={13} className={refreshStatus.isPending ? "animate-spin" : ""} /> جارٍ التحقق من الربط تلقائياً</p>}</div>
            <div className="rounded-2xl border border-[#cfe0d9] bg-[#f7fbf8] p-4"><h3 className="font-extrabold text-[#173f38]">تغيير رقم واتساب</h3><p className="mt-1 text-xs leading-5 text-[#6b7e78]">اكتب الرقم البديل بصيغة دولية، ثم أنشئ QR جديداً. لا تحتاج إلى تغيير أي إعداد في Wasender يدوياً.</p><label className="mt-3 block text-xs font-bold text-[#395d54]">رقم واتساب الجديد<input className="field-input mt-2 bg-white" placeholder="+9665xxxxxxxx" value={replacementPhoneNumber} onChange={event => setReplacementPhoneNumber(event.target.value)} /></label><button className="action-primary mt-3 w-full justify-center" onClick={saveReplacementPhone} disabled={recreateSession.isPending || replacementPhoneNumber.trim().length < 7}>{recreateSession.isPending ? "جارٍ إنشاء QR..." : "حفظ الرقم وإنشاء QR"}</button></div>
            {["disconnected", "logged_out", "expired"].includes(status) && <p className="rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-900">إذا رفض Wasender الرقم الجديد لأنه مرتبط بجلسة في حساب آخر، اختر رقماً غير مستخدم أو اطلب تحريره من <a className="font-bold underline" href="https://wasenderapi.com/contact" target="_blank" rel="noreferrer">دعم Wasender</a>.</p>}
            <div className="flex flex-wrap gap-2"><button className="action-secondary" onClick={() => refreshStatus.mutate()} disabled={refreshStatus.isPending}><RefreshCw size={16} /> تحديث الحالة</button><button className="action-secondary" onClick={() => { void utils.mongoBooking.admin.whatsapp.config.invalidate(); void utils.mongoBooking.admin.whatsapp.messages.invalidate(); }}><Wifi size={16} /> تحديث السجل</button><button className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50" onClick={endSession} disabled={disconnectSession.isPending}>{disconnectSession.isPending ? "جارٍ إنهاء الجلسة..." : "إنهاء جلسة واتساب"}</button></div>
          </div>
        </div>}
      </div>
      <div className="surface-card p-5"><h2 className="text-lg font-extrabold text-[#173f38]">ملخص الرسائل</h2><p className="mt-1 text-sm text-[#748581]">كل محاولة إرسال للحجوزات المسجلة.</p><div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-[#eef8f4] p-3"><CheckCircle2 size={17} className="text-emerald-600" /><strong className="mt-2 block text-xl text-[#173f38]">{counts.delivered ?? 0}</strong><span className="text-xs text-[#6c7f79]">تم التسليم</span></div><div className="rounded-2xl bg-[#fff7e9] p-3"><Clock3 size={17} className="text-amber-600" /><strong className="mt-2 block text-xl text-[#173f38]">{(counts.pending ?? 0) + (counts.in_progress ?? 0)}</strong><span className="text-xs text-[#6c7f79]">قيد المعالجة</span></div><div className="rounded-2xl bg-[#fff0ef] p-3"><XCircle size={17} className="text-rose-600" /><strong className="mt-2 block text-xl text-[#173f38]">{counts.failed ?? 0}</strong><span className="text-xs text-[#6c7f79]">فشل</span></div><div className="rounded-2xl bg-[#f2f5f4] p-3"><Smartphone size={17} className="text-[#18846f]" /><strong className="mt-2 block text-xl text-[#173f38]">{messages.data?.length ?? 0}</strong><span className="text-xs text-[#6c7f79]">إجمالي السجل</span></div></div></div>
    </div>
    <div className="surface-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-extrabold text-[#173f38]">الرسائل التلقائية للرحلات</h2><p className="mt-1 text-sm leading-6 text-[#748581]">يفحص النظام الرحلات بانتظام ويرسل التذكير قبل المغادرة، ثم رسالة متابعة بعد الرحلة. لا تُرسل رسالة مكررة لنفس الحجز.</p></div><span className="rounded-full bg-[#edf6f0] px-3 py-1 text-xs font-bold text-[#2d7a60]">تشغيل تلقائي</span></div><div className="mt-5 grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border border-[#dbe8e1] bg-[#f8fcf9] p-4"><label className="flex items-center justify-between gap-3 text-sm font-extrabold text-[#173f38]"><span>تذكير قبل الرحلة</span><input type="checkbox" checked={automationForm.reminderEnabled} onChange={event => setAutomationForm(current => ({ ...current, reminderEnabled: event.target.checked }))} /></label><label className="mt-4 block text-xs font-bold text-[#456158]">قبل الموعد بكم دقيقة؟<input className="field-input mt-2 bg-white" type="number" min="15" max="1440" value={automationForm.reminderLeadMinutes} onChange={event => setAutomationForm(current => ({ ...current, reminderLeadMinutes: event.target.value }))} /></label><p className="mt-2 text-xs text-[#748581]">الإعداد الافتراضي: 120 دقيقة.</p></div><div className="rounded-2xl border border-[#dbe8e1] bg-[#f8fcf9] p-4"><label className="flex items-center justify-between gap-3 text-sm font-extrabold text-[#173f38]"><span>متابعة بعد الرحلة</span><input type="checkbox" checked={automationForm.feedbackEnabled} onChange={event => setAutomationForm(current => ({ ...current, feedbackEnabled: event.target.checked }))} /></label><label className="mt-4 block text-xs font-bold text-[#456158]">بعد الموعد بكم دقيقة؟<input className="field-input mt-2 bg-white" type="number" min="30" max="10080" value={automationForm.feedbackDelayMinutes} onChange={event => setAutomationForm(current => ({ ...current, feedbackDelayMinutes: event.target.value }))} /></label><p className="mt-2 text-xs text-[#748581]">الإعداد الافتراضي: 360 دقيقة.</p></div><label className="block text-xs font-bold text-[#456158] lg:col-span-2">رابط تقييم Google Maps<input className="field-input mt-2 bg-white" type="url" placeholder="https://g.page/r/.../review" value={automationForm.googleReviewUrl} onChange={event => setAutomationForm(current => ({ ...current, googleReviewUrl: event.target.value }))} /></label></div><div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-[#fff9ef] px-4 py-3 text-xs leading-6 text-[#7d6233]"><span>يرد العميل بـ 1 للتجربة الجيدة فيستلم رابط التقييم، أو بـ 2/تفاصيل المشكلة لتسجل ملاحظته وتصل رسالة اعتذار.</span><button className="action-primary shrink-0" onClick={saveAutomation} disabled={updateAutomation.isPending}>{updateAutomation.isPending ? "جارٍ الحفظ..." : "حفظ الإعدادات"}</button></div></div>
    <div className="surface-card overflow-hidden"><div className="flex items-center justify-between border-b border-[#e8efec] p-5"><div><h2 className="text-lg font-extrabold text-[#173f38]">متابعة رضا العملاء</h2><p className="mt-1 text-sm text-[#748581]">الردود السلبية تُحفظ هنا كي يتواصل فريق المكتب مع العميل.</p></div><span className="rounded-full bg-[#fff0ef] px-3 py-1 text-xs font-bold text-rose-700">{(customerFeedback.data ?? []).filter(item => item.rating === "issue").length} مشكلات</span></div>{customerFeedback.data?.length ? <div className="overflow-x-auto"><table className="w-full text-right text-sm"><thead className="bg-[#f8faf9] text-xs text-[#71827e]"><tr><th className="p-4">العميل</th><th className="p-4">الحجز</th><th className="p-4">النتيجة</th><th className="p-4">الملاحظة</th><th className="p-4">الوقت</th></tr></thead><tbody>{customerFeedback.data.map((item, index) => <tr key={`${item.bookingCode}-${index}`} className="border-t border-[#eef2f0]"><td className="p-4"><p className="font-bold text-[#173f38]">{item.reservation?.passengerName ?? "عميل"}</p><p className="mt-1 text-xs text-[#71827e]" dir="ltr">{item.recipientPhone}</p></td><td className="p-4">{item.bookingCode}</td><td className={`p-4 font-bold ${item.rating === "positive" ? "text-emerald-700" : "text-rose-700"}`}>{item.rating === "positive" ? "تجربة جيدة" : "تحتاج متابعة"}</td><td className="p-4 text-[#526b65]">{item.issueText || "—"}</td><td className="p-4 text-[#71827e]">{item.createdAt ? new Date(item.createdAt).toLocaleString("ar-SA") : "—"}</td></tr>)}</tbody></table></div> : <div className="p-7 text-center text-sm text-[#748581]">لم تصل ردود متابعة بعد.</div>}</div>
    <div className="surface-card overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e8efec] p-5"><div><h2 className="text-lg font-extrabold text-[#173f38]">آخر الرسائل</h2><p className="mt-1 text-sm text-[#748581]">صنّف السجل حسب الغرض أو الحالة، ولا تُعاد أي رسالة إلا بعد تأكيد صريح من المدير.</p></div><div className="flex flex-wrap gap-2"><select className="field-input !w-auto !py-2 text-xs" value={messageCategoryFilter} onChange={event => setMessageCategoryFilter(event.target.value)}><option value="all">كل الأغراض</option>{Object.entries(messageCategoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select className="field-input !w-auto !py-2 text-xs" value={messageStatusFilter} onChange={event => setMessageStatusFilter(event.target.value)}><option value="all">كل الحالات</option>{Object.entries(messageStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div></div><div className="overflow-x-auto"><table className="w-full text-right text-sm"><thead className="bg-[#f8faf9] text-xs text-[#71827e]"><tr><th className="p-4">الحجز</th><th className="p-4">الغرض</th><th className="p-4">طريقة الإرسال</th><th className="p-4">الحالة والسبب</th><th className="p-4">المحاولة</th><th className="p-4">الوقت</th><th className="p-4" /></tr></thead><tbody>{(messages.data ?? []).map((item, index) => { const normalizedStatus = normalizeStoredMessageStatus(item.status); const canRetry = ["failed", "rate_limited", "not_configured"].includes(normalizedStatus) && ["reservation", "external", "trust"].includes(String(item.bookingType)); return <tr key={`${item.bookingCode}-${item.attempt}-${index}`} className="border-t border-[#eef2f0]"><td className="p-4 font-bold text-[#173f38]">{item.bookingCode || "—"}</td><td className="p-4"><p className="font-semibold">{messageCategoryLabels[String(item.category ?? "booking")] ?? "رسالة تشغيل"}</p><p className="mt-1 text-[9px] text-[#81918c]">{item.bookingType === "trust" ? "أمانة" : item.bookingType === "external" ? "حجز خارجي" : item.bookingType === "password_reset" ? "حساب" : "حجز"}</p></td><td className="p-4">{item.mode === "automatic" ? "تلقائي" : item.mode === "manual_link" ? "رابط يدوي" : "يدوي"}</td><td className="p-4"><p className={normalizedStatus === "failed" ? "font-bold text-rose-700" : normalizedStatus === "delivered" || normalizedStatus === "read" ? "font-bold text-emerald-700" : "font-bold text-[#526b65]"}>{messageStatusLabels[normalizedStatus] ?? String(item.status ?? "غير معروف")}</p>{item.errorMessage && <p className="mt-1 max-w-[250px] text-[9px] leading-4 text-rose-600">{String(item.errorMessage)}</p>}</td><td className="p-4">{item.attempt}</td><td className="p-4 text-[#71827e]">{item.createdAt ? new Date(item.createdAt).toLocaleString("ar-SA") : "—"}</td><td className="p-4">{canRetry ? <button className="action-secondary !px-3 !py-2 text-[10px]" disabled={retryMessage.isPending} onClick={() => { if (window.confirm(`إعادة إرسال تفاصيل ${item.bookingCode} الآن؟ سيصل للعميل إشعار جديد.`)) retryMessage.mutate({ bookingType: item.bookingType as "reservation" | "external" | "trust", bookingCode: String(item.bookingCode) }); }}>إعادة إرسال</button> : "—"}</td></tr>; })}</tbody></table></div></div>
  </section>;
}
