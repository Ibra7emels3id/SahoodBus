import { ArrowLeft, BadgeCheck, BusFront, Eye, EyeOff, KeyRound, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export default function Login() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetStep, setResetStep] = useState<"request" | "confirm">("request");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const login = trpc.auth.login.useMutation({
    onSuccess: async ({ token, user }) => {
      sessionStorage.setItem("suhoud-local-session", token);
      utils.auth.me.setData(undefined, { ...user, branchName: null });
      await utils.auth.me.invalidate();
      toast.success("تم تسجيل الدخول بنجاح.");
      navigate("/");
    },
    onError: error => toast.error(error.message || "تعذر تسجيل الدخول."),
  });
  const requestReset = trpc.auth.passwordReset.request.useMutation({ onSuccess: () => { toast.success("إذا كان للحساب رقم واتساب مسجل، أُرسل إليه رمز التحقق."); setResetMode(true); setResetStep("confirm"); }, onError: () => toast.success("إذا كان للحساب رقم واتساب مسجل، أُرسل إليه رمز التحقق.") });
  const confirmReset = trpc.auth.passwordReset.confirm.useMutation({ onSuccess: () => { toast.success("تم تعيين كلمة المرور الجديدة. يمكنك تسجيل الدخول الآن."); setResetMode(false); setResetStep("request"); setPassword(""); setResetCode(""); setNewPassword(""); setConfirmPassword(""); }, onError: error => toast.error(error.message) });
  const submit = (event: React.FormEvent) => { event.preventDefault(); login.mutate({ email, password }); };
  const submitResetRequest = (event: React.FormEvent) => { event.preventDefault(); requestReset.mutate({ email }); };
  const submitResetConfirm = (event: React.FormEvent) => { event.preventDefault(); if (newPassword !== confirmPassword) { toast.error("كلمتا المرور غير متطابقتين."); return; } confirmReset.mutate({ email, code: resetCode, password: newPassword }); };
  const isBusy = login.isPending || requestReset.isPending || confirmReset.isPending;
  const resetTitle = resetStep === "confirm" ? "تعيين كلمة مرور جديدة" : "استعادة كلمة المرور";
  const resetDescription = resetStep === "confirm" ? "أدخل الرمز المؤقت، ثم أنشئ كلمة مرور جديدة لحسابك." : "سنرسل رمز تحقق مؤقتاً إلى رقم واتساب المسجل للحساب.";

  return <main className="login-screen" dir="rtl">
    <section className="login-panel">
      <div className="login-content">
        <header className="login-topbar">
          <div className="login-brand" aria-label="حافلة سهود">
            <span><BusFront size={23} strokeWidth={2.25} /></span>
            <div><p>SUHOUD BUS</p><h1>حافلة سهود</h1></div>
          </div>
          <span className="login-portal-label"><ShieldCheck size={14} /> بوابة الموظفين</span>
        </header>

        <div className="login-intro">
          <span className="login-eyebrow"><i /> وصول آمن إلى النظام</span>
          <h2>{resetMode ? resetTitle : "أهلاً بعودتك"}</h2>
          <p>{resetMode ? resetDescription : "سجّل الدخول لإدارة الرحلات والحجوزات والخزنة ضمن الصلاحيات المخصصة لحسابك."}</p>
        </div>

        <div className="login-form-card">
          {!resetMode ? <form onSubmit={submit} className="login-form" noValidate>
            <label className="login-label">البريد الإلكتروني
              <div className="login-input"><Mail size={18} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" required autoComplete="email" inputMode="email" dir="ltr" /></div>
            </label>
            <label className="login-label">كلمة المرور
              <div className="login-input"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} value={password} onChange={event => setPassword(event.target.value)} placeholder="أدخل كلمة المرور" required minLength={8} autoComplete="current-password" /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
            </label>
            <button type="button" className="login-link" onClick={() => { setResetMode(true); setResetStep("request"); setResetCode(""); }}><KeyRound size={14} /> نسيت كلمة المرور؟</button>
            <button className="login-submit" disabled={isBusy}>{login.isPending ? "جارٍ التحقق من بياناتك..." : <><span>دخول إلى النظام</span><ArrowLeft size={17} /></>}</button>
          </form> : <form onSubmit={resetStep === "confirm" ? submitResetConfirm : submitResetRequest} className="login-form" noValidate>
            <label className="login-label">البريد الإلكتروني
              <div className="login-input"><Mail size={18} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" required autoComplete="email" inputMode="email" dir="ltr" /></div>
            </label>
            {resetStep === "confirm" ? <>
              <label className="login-label">رمز واتساب المكوّن من 6 أرقام
                <div className="login-input"><KeyRound size={18} /><input className="login-code-input" value={resetCode} onChange={event => setResetCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" required /></div>
              </label>
              <label className="login-label">كلمة المرور الجديدة
                <div className="login-input"><LockKeyhole size={18} /><input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="8 أحرف على الأقل" minLength={8} required autoComplete="new-password" /></div>
              </label>
              <label className="login-label">تأكيد كلمة المرور
                <div className="login-input"><LockKeyhole size={18} /><input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="أعد كتابة كلمة المرور" minLength={8} required autoComplete="new-password" /></div>
              </label>
            </> : <p className="login-reset-note"><ShieldCheck size={17} /><span>لخصوصيتك، لا نعرض ما إذا كان البريد مسجلاً. إن وُجد رقم واتساب للحساب، سيصل إليه الرمز.</span></p>}
            <button className="login-submit" disabled={isBusy}>{resetStep === "confirm" ? (confirmReset.isPending ? "جارٍ حفظ كلمة المرور..." : <><span>حفظ كلمة المرور</span><ArrowLeft size={17} /></>) : (requestReset.isPending ? "جارٍ إرسال الرمز..." : <><span>إرسال رمز واتساب</span><ArrowLeft size={17} /></>)}</button>
            <div className="login-reset-actions"><button type="button" className="login-link" onClick={() => { setResetMode(false); setResetStep("request"); setResetCode(""); }}>العودة لتسجيل الدخول</button>{resetStep === "confirm" && <button type="button" className="login-link" onClick={() => { setResetStep("request"); setResetCode(""); }}>إرسال رمز جديد</button>}</div>
          </form>}
        </div>

        <p className="login-security"><ShieldCheck size={16} /><span>اتصال محمي. صلاحيات كل مستخدم وفرعه تُحدد تلقائياً بعد تسجيل الدخول.</span></p>
      </div>
    </section>

    <aside className="login-aside" aria-label="مزايا النظام">
      <div className="login-aside-top"><span className="login-route-dot" /><span>إدارة تشغيل موحدة</span></div>
      <div className="login-aside-content">
        <p>نظام إدارة الحجوزات</p>
        <h2>تنظيم الرحلات<br />يبدأ من هنا.</h2>
        <p className="login-aside-copy">لوحة داخلية تجمع كل ما يحتاجه فريق العمل لإدارة التشغيل اليومي بثقة ووضوح.</p>
      </div>
      <div className="login-feature-grid">
        <div><BusFront size={19} /><span>الرحلات والمقاعد</span></div>
        <div><BadgeCheck size={19} /><span>الحجوزات والأمانات</span></div>
        <div><ShieldCheck size={19} /><span>صلاحيات حسب الفرع</span></div>
      </div>
      <div className="login-aside-footer"><span>SAHOOD OPERATIONS</span><span>إصدار تشغيلي</span></div>
    </aside>
  </main>;
}
