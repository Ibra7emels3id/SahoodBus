import crypto from "node:crypto";
import QRCode from "qrcode";
import type { Request, Response } from "express";
import { getMongoDb } from "./mongo";

const WASENDER_BASE_URL = "https://www.wasenderapi.com";
const encryptionKey = () => crypto.createHash("sha256").update(process.env.JWT_SECRET ?? "").digest();

export type WasenderStatus = "connected" | "connecting" | "need_scan" | "need_passkey" | "disconnected" | "logged_out" | "expired" | "unknown";
export type WhatsAppRecordType = "reservation" | "external" | "trust" | "password_reset";

export type WasenderSessionView = {
  providerSessionId: number;
  name: string;
  phoneNumber: string;
  status: WasenderStatus;
  qrCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function encryptSecret(value: string): string {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required to protect Wasender session secrets");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [ivPart, tagPart, encryptedPart] = value.split(".");
  if (!ivPart || !tagPart || !encryptedPart || !process.env.JWT_SECRET) throw new Error("Invalid protected Wasender secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8");
}

export function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeWhatsAppPhone(phone: string, defaultCountryCode = "966"): string {
  const compact = phone.trim().replace(/[\s()-]/g, "");
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  const digits = compact.replace(/\D/g, "");
  const countryCode = (defaultCountryCode || "966").replace(/\D/g, "");
  if (digits.startsWith("0")) return `+${countryCode}${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) return `+${countryCode}${digits}`;
  return `+${digits}`;
}

export function normalizeWasenderMessageStatus(value: unknown): string {
  const numericStatus = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : null;
  if (numericStatus !== null) return ({ 0: "failed", 1: "pending", 2: "sent", 3: "delivered", 4: "read", 5: "played" } as Record<number, string>)[numericStatus] ?? "unknown";
  const status = String(value ?? "in_progress").trim().toLowerCase();
  if (["sent", "delivered", "read", "played", "failed", "pending", "in_progress"].includes(status)) return status;
  return status || "in_progress";
}

async function requestWasender(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${WASENDER_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const providerMessage = typeof payload.message === "string" ? payload.message : `Wasender API returned HTTP ${response.status}`;
    const message = /phone number has already been taken/i.test(providerMessage)
      ? "رقم واتساب مرتبط بالفعل بجلسة Wasender في حساب آخر. حرر الرقم من الحساب السابق أو استخدم رقماً آخر ثم أعد المحاولة."
      : providerMessage;
    throw new Error(message);
  }
  return payload;
}

async function requestWasenderQrCode(providerSessionId: number): Promise<string | null> {
  const token = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const payload = await requestWasender(`/api/whatsapp-sessions/${providerSessionId}/qrcode`, token);
    return typeof payload.data?.qrCode === "string" && payload.data.qrCode ? payload.data.qrCode : null;
  } catch {
    // The QR endpoint is available only after the connection has initialized.
    return null;
  }
}

async function initiateWasenderQrConnection(providerSessionId: number): Promise<{ status: WasenderStatus; qrCode: string | null }> {
  const token = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("لم يتم إعداد رمز Wasender في أسرار الخادم.");
  const connected = await requestWasender(`/api/whatsapp-sessions/${providerSessionId}/connect`, token, { method: "POST", body: JSON.stringify({ linkMethod: "qr" }) });
  const status = String(connected.data?.status ?? "connecting").toLowerCase() as WasenderStatus;
  const qrCode = typeof connected.data?.qrCode === "string" ? connected.data.qrCode : null;
  return { status, qrCode: qrCode ?? (status === "need_scan" ? await requestWasenderQrCode(providerSessionId) : null) };
}

function publicOrigin(req: Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0];
  const host = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "");
  if (!host || /[^a-zA-Z0-9.:-]/.test(host)) throw new Error("تعذر تحديد رابط webhook الآمن");
  return `${forwardedProto === "https" ? "https" : "http"}://${host}`;
}

export async function createWasenderSession(input: { name: string; phoneNumber: string; req: Request }) {
  const token = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("لم يتم إعداد رمز Wasender في أسرار الخادم.");
  const payload = await requestWasender("/api/whatsapp-sessions", token, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      phone_number: normalizeWhatsAppPhone(input.phoneNumber, process.env.WASENDER_DEFAULT_COUNTRY_CODE),
      account_protection: true,
      log_messages: true,
      webhook_url: `${publicOrigin(input.req)}/api/wasender/webhook`,
      webhook_enabled: true,
      // Wasender validates this array at session creation. These values match its
      // documented create-session example; messages.update carries delivery/read updates.
      webhook_events: ["messages.received", "session.status", "messages.update"],
    }),
  });
  const data = payload.data as { id: number; name: string; phone_number: string; api_key: string; webhook_secret?: string };
  const db = await getMongoDb();
  await db.collection("wasenderSessions").updateMany({ isActive: true }, { $set: { isActive: false, updatedAt: new Date() } });
  await db.collection("wasenderSessions").insertOne({
    providerSessionId: Number(data.id),
    name: data.name,
    phoneNumber: data.phone_number,
    encryptedApiKey: encryptSecret(data.api_key),
    apiKeyHash: hashSecret(data.api_key),
    encryptedWebhookSecret: data.webhook_secret ? encryptSecret(data.webhook_secret) : null,
    status: "connecting",
    qrCode: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const connection = await initiateWasenderQrConnection(Number(data.id));
  await db.collection("wasenderSessions").updateOne({ providerSessionId: Number(data.id), isActive: true }, { $set: { status: connection.status, qrCode: connection.qrCode, updatedAt: new Date() } });
  return { providerSessionId: Number(data.id), name: data.name, phoneNumber: data.phone_number, ...connection };
}

export async function qrCodeDataUrl(qrCode: string): Promise<string> {
  return QRCode.toDataURL(qrCode, { width: 320, margin: 2, errorCorrectionLevel: "M" });
}

function appendBranchDetails(lines: string[], item: Record<string, any>) {
  if (item.branchName) lines.push(`اسم الفرع: ${String(item.branchName)}`);
  if (item.branchContactPhone) lines.push(`رقم الفرع: ${String(item.branchContactPhone)}`);
  if (item.branchLocationUrl) lines.push(`موقع الفرع: ${String(item.branchLocationUrl)}`);
}

export function buildBookingMessage(item: Record<string, any>, bookingType: WhatsAppRecordType): string {
  const code = String(item.reservationCode ?? item.externalBookingCode ?? item.trustCode ?? "");
  if (bookingType === "trust") {
    const lines = ["حافلة سهود", "تفاصيل الأمانة", `رقم الأمانة: ${code}`, `المرسل: ${String(item.senderName ?? "")}`, `المستلم: ${String(item.recipientName ?? "")}`, `وصف الأمانة: ${String(item.itemDescription ?? "")}`, `عدد الأغراض: ${String(item.itemCount ?? 0)}`, `رسوم الأمانة: ${Number(item.fee ?? item.price ?? 0)} ر.س`, `المسار: ${String(item.routeName ?? item.tripCode ?? "")}`];
    appendBranchDetails(lines, item);
    return lines.join("\n");
  }
  const lines = ["حافلة سهود", "تفاصيل الحجز", `رقم الحجز: ${code}`, `اسم المسافر: ${String(item.passengerName ?? "")}`, `رقم الهاتف: ${String(item.phone ?? "")}`];
  if (bookingType === "reservation") lines.push(`المسار: ${String(item.routeName ?? item.tripCode ?? "")}`, `المقعد: ${String(item.seatNumber ?? "")}`, `موعد الرحلة: ${item.departureAt ? new Date(item.departureAt).toLocaleString("ar-SA") : "غير محدد"}`);
  else lines.push(`المسار: ${String(item.routeName ?? "")}`, `تاريخ السفر: ${String(item.travelDate ?? "غير محدد")}`, `المكتب الخارجي: ${String(item.externalOfficeName ?? "")}`);
  lines.push(`عدد الشنط: ${String(item.luggageCount ?? 0)}`, `قيمة التذكرة: ${Number(item.ticketPrice ?? 0)} ر.س`, "يرجى الحضور قبل موعد الرحلة بوقت كافٍ.");
  appendBranchDetails(lines, item);
  return lines.join("\n");
}

export function buildManualWhatsAppUrl(phone: string, text: string, defaultCountryCode = ""): string {
  const recipientPhone = normalizeWhatsAppPhone(phone, defaultCountryCode);
  return `https://wa.me/${recipientPhone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

export async function createManualWhatsAppLink(input: { to: string; text: string; bookingType: WhatsAppRecordType; bookingCode: string; createdByUserId: number }) {
  const db = await getMongoDb();
  const attempt = await db.collection("whatsappMessages").countDocuments({ bookingType: input.bookingType, bookingCode: input.bookingCode }) + 1;
  const recipientPhone = normalizeWhatsAppPhone(input.to, process.env.WASENDER_DEFAULT_COUNTRY_CODE);
  await db.collection("whatsappMessages").insertOne({
    bookingType: input.bookingType,
    bookingCode: input.bookingCode,
    recipientPhone,
    mode: "manual_link",
    attempt,
    status: "manual_link_opened",
    messagePreview: input.text.slice(0, 180),
    createdByUserId: input.createdByUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { attempt, url: buildManualWhatsAppUrl(input.to, input.text, process.env.WASENDER_DEFAULT_COUNTRY_CODE) };
}

export async function sendWasenderText(input: { to: string; text: string; bookingType: WhatsAppRecordType; bookingCode: string; mode: "automatic" | "manual"; category?: string; auditPreview?: string; createdByUserId: number }) {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: true });
  const attempt = await db.collection("whatsappMessages").countDocuments({ bookingType: input.bookingType, bookingCode: input.bookingCode }) + 1;
  const baseLog = { bookingType: input.bookingType, bookingCode: input.bookingCode, recipientPhone: normalizeWhatsAppPhone(input.to, process.env.WASENDER_DEFAULT_COUNTRY_CODE), mode: input.mode, category: input.category ?? "booking", attempt, messagePreview: (input.auditPreview ?? input.text).slice(0, 180), createdByUserId: input.createdByUserId, createdAt: new Date(), updatedAt: new Date() };
  if (!session) {
    await db.collection("whatsappMessages").insertOne({ ...baseLog, status: "not_configured" });
    return { status: "not_configured" as const, attempt };
  }
  const log = await db.collection("whatsappMessages").insertOne({ ...baseLog, providerSessionId: Number(session.providerSessionId), status: "pending" });
  try {
    const payload = await requestWasender("/api/send-message", decryptSecret(String(session.encryptedApiKey)), { method: "POST", body: JSON.stringify({ to: normalizeWhatsAppPhone(input.to, process.env.WASENDER_DEFAULT_COUNTRY_CODE), text: input.text }) });
    const providerMessageId = String(payload.data?.msgId ?? payload.data?.id ?? "");
    const status = normalizeWasenderMessageStatus(payload.data?.status ?? "in_progress");
    await db.collection("whatsappMessages").updateOne({ _id: log.insertedId }, { $set: { providerMessageId: providerMessageId || null, status, sentAt: new Date(), updatedAt: new Date() } });
    return { status, providerMessageId, attempt };
  } catch (error) {
    const providerError = error instanceof Error ? error.message : "تعذر الإرسال عبر Wasender";
    const isRateLimited = /free trial.*1 message every 1 minute/i.test(providerError);
    const errorMessage = isRateLimited ? "حد التجربة المجاني: رسالة واحدة كل دقيقة. أعد المحاولة بعد دقيقة أو فعّل خطة Wasender مناسبة." : providerError;
    const status = isRateLimited ? "rate_limited" : "failed";
    await db.collection("whatsappMessages").updateOne({ _id: log.insertedId }, { $set: { status, errorMessage: errorMessage.slice(0, 300), updatedAt: new Date() } });
    return { status, errorMessage: errorMessage.slice(0, 300), attempt };
  }
}

async function handleInboundCustomerFeedback(input: { senderPhone: string; messageText: string }) {
  const db = await getMongoDb();
  const phone = normalizeWhatsAppPhone(input.senderPhone, process.env.WASENDER_DEFAULT_COUNTRY_CODE);
  const feedbackRequest = await db.collection("whatsappMessages").findOne({ category: "feedback_request", recipientPhone: phone }, { sort: { createdAt: -1 } });
  if (!feedbackRequest) return { handled: false };
  const existing = await db.collection("customerFeedback").findOne({ feedbackRequestMessageId: feedbackRequest._id });
  if (existing) return { handled: true, duplicate: true };
  const text = input.messageText.trim();
  const isPositive = text === "1" || /^(نعم|جيدة|كويسة|ممتاز|رائع)/i.test(text);
  const settings = await db.collection("automationSettings").findOne({ _id: "trip-messaging" } as any);
  const reviewUrl = String(settings?.googleReviewUrl ?? "").trim();
  await db.collection("customerFeedback").insertOne({ feedbackRequestMessageId: feedbackRequest._id, bookingCode: feedbackRequest.bookingCode, recipientPhone: phone, rating: isPositive ? "positive" : "issue", issueText: isPositive ? "" : (text === "2" ? "" : text), createdAt: new Date(), updatedAt: new Date() });
  const replyText = isPositive
    ? (reviewUrl ? `شكراً لثقتك في حافلة سهود. يسعدنا تقييمك الإيجابي على Google Maps:\n${reviewUrl}` : "شكراً لثقتك في حافلة سهود وتقييمك الإيجابي.")
    : "نعتذر عن التجربة التي لم تكن بالمستوى المطلوب. تم تسجيل ملاحظتك وسيتواصل معك فريق حافلة سهود لفهم المشكلة وتقديم ما يلزم.";
  await sendWasenderText({ to: phone, text: replyText, bookingType: "reservation", bookingCode: String(feedbackRequest.bookingCode), mode: "automatic", category: isPositive ? "feedback_review" : "feedback_ack", createdByUserId: 0 });
  return { handled: true, rating: isPositive ? "positive" : "issue" };
}

export async function getActiveWasenderSession(): Promise<WasenderSessionView | null> {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: true }, { projection: { _id: 0, encryptedApiKey: 0, encryptedWebhookSecret: 0, apiKeyHash: 0 } });
  return session as WasenderSessionView | null;
}

export async function getReconnectableWasenderSession(): Promise<WasenderSessionView | null> {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: false, status: "disconnected" }, { projection: { _id: 0, encryptedApiKey: 0, encryptedWebhookSecret: 0, apiKeyHash: 0 }, sort: { updatedAt: -1 } });
  return session as WasenderSessionView | null;
}

export async function refreshWasenderSession() {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: true });
  if (!session) return null;
  const statusPayload = await requestWasender("/api/status", decryptSecret(String(session.encryptedApiKey)));
  const currentStatus = String(statusPayload.status ?? "unknown").toLowerCase() as WasenderStatus;
  const connection = ["disconnected", "logged_out", "expired"].includes(currentStatus)
    ? await initiateWasenderQrConnection(Number(session.providerSessionId))
    : { status: currentStatus, qrCode: currentStatus === "need_scan" ? await requestWasenderQrCode(Number(session.providerSessionId)) : (typeof session.qrCode === "string" ? session.qrCode : null) };
  const { status, qrCode } = connection;
  await db.collection("wasenderSessions").updateOne({ _id: session._id }, { $set: { status, qrCode, updatedAt: new Date() } });
  return { providerSessionId: Number(session.providerSessionId), name: String(session.name), phoneNumber: String(session.phoneNumber), status, qrCode };
}

export async function disconnectWasenderSession() {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: true });
  if (!session) return { disconnected: false, message: "لا توجد جلسة واتساب نشطة." };
  const token = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("لم يتم إعداد رمز Wasender في أسرار الخادم.");
  await requestWasender(`/api/whatsapp-sessions/${Number(session.providerSessionId)}/disconnect`, token, { method: "POST" });
  await db.collection("wasenderSessions").updateOne({ _id: session._id }, { $set: { isActive: false, status: "disconnected", qrCode: null, disconnectedAt: new Date(), updatedAt: new Date() } });
  return { disconnected: true, providerSessionId: Number(session.providerSessionId) };
}

export async function reconnectWasenderSession() {
  const db = await getMongoDb();
  const session = await db.collection("wasenderSessions").findOne({ isActive: false, status: "disconnected" }, { sort: { updatedAt: -1 } });
  if (!session) throw new Error("لا توجد جلسة مفصولة لإعادة ربطها. أنشئ جلسة جديدة برقم آخر.");
  await db.collection("wasenderSessions").updateMany({ isActive: true }, { $set: { isActive: false, updatedAt: new Date() } });
  const connection = await initiateWasenderQrConnection(Number(session.providerSessionId));
  await db.collection("wasenderSessions").updateOne({ _id: session._id }, { $set: { isActive: true, status: connection.status, qrCode: connection.qrCode, reconnectedAt: new Date(), updatedAt: new Date() } });
  return { providerSessionId: Number(session.providerSessionId), name: String(session.name), phoneNumber: String(session.phoneNumber), ...connection };
}

export async function handleWasenderWebhook(req: Request, res: Response) {
  const payload = req.body as { event?: string; sessionId?: string; data?: Record<string, any>; timestamp?: number };
  const sessionApiKey = typeof payload.sessionId === "string" ? payload.sessionId : "";
  const db = await getMongoDb();
  const session = sessionApiKey ? await db.collection("wasenderSessions").findOne({ apiKeyHash: hashSecret(sessionApiKey), isActive: true }) : null;
  if (!session || !session.encryptedWebhookSecret || String(req.headers["x-webhook-signature"] ?? "") !== decryptSecret(String(session.encryptedWebhookSecret))) return res.status(401).json({ received: false });
  const event = String(payload.event ?? "unknown");
  const data = payload.data ?? {};
  if (event === "session.status") await db.collection("wasenderSessions").updateOne({ _id: session._id }, { $set: { status: String(data.status ?? "unknown").toLowerCase(), updatedAt: new Date() } });
  if (event === "qrcode.updated" && typeof data.qr === "string") await db.collection("wasenderSessions").updateOne({ _id: session._id }, { $set: { qrCode: data.qr, status: "need_scan", updatedAt: new Date() } });
  if (event === "messages.update" || event === "message.sent" || event === "messages.sent" || event === "message-receipt.update") {
    const key = data.key ?? data.message?.key ?? {};
    const messageId = String(key.id ?? data.msgId ?? "");
    const status = event === "message.sent" || event === "messages.sent" ? "sent" : normalizeWasenderMessageStatus(data.update?.status ?? data.status ?? "in_progress");
    if (messageId) await db.collection("whatsappMessages").updateOne({ providerMessageId: messageId }, { $set: { status, lastWebhookEvent: event, updatedAt: new Date() }, $setOnInsert: { providerSessionId: Number(session.providerSessionId), providerMessageId: messageId, createdAt: new Date() } }, { upsert: true });
  }
  if (event === "messages.received") {
    const message = data.messages ?? {};
    const key = message.key ?? {};
    const senderPhone = String(key.cleanedSenderPn ?? key.senderPn ?? key.remoteJid ?? "");
    const messageText = String(message.messageBody ?? message.message?.conversation ?? "");
    if (!key.fromMe && senderPhone && messageText) await handleInboundCustomerFeedback({ senderPhone, messageText });
  }
  return res.status(200).json({ received: true });
}

export async function getWasenderConfigState() {
  return { configured: Boolean(process.env.WASENDER_PERSONAL_ACCESS_TOKEN), hasDefaultCountryCode: Boolean(process.env.WASENDER_DEFAULT_COUNTRY_CODE) };
}
