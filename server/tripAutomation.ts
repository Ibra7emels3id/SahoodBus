import { getMongoDb } from "./mongo";
import { buildBookingMessage, normalizeWhatsAppPhone, sendWasenderText } from "./wasender";
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";

export type TripAutomationSettings = {
  reminderEnabled: boolean;
  reminderLeadMinutes: number;
  feedbackEnabled: boolean;
  feedbackDelayMinutes: number;
  googleReviewUrl: string;
};

const SETTINGS_ID = "trip-messaging";
const defaults: TripAutomationSettings = { reminderEnabled: true, reminderLeadMinutes: 120, feedbackEnabled: true, feedbackDelayMinutes: 360, googleReviewUrl: "" };

export async function getTripAutomationSettings(): Promise<TripAutomationSettings> {
  const db = await getMongoDb();
  const stored = await db.collection("automationSettings").findOne({ _id: SETTINGS_ID } as any);
  return { ...defaults, ...(stored ?? {}) };
}

export async function saveTripAutomationSettings(input: TripAutomationSettings): Promise<TripAutomationSettings> {
  const db = await getMongoDb();
  await db.collection("automationSettings").updateOne({ _id: SETTINGS_ID } as any, { $set: { ...input, updatedAt: new Date() } }, { upsert: true });
  return input;
}

async function alreadyQueued(bookingCode: string, category: string) {
  const db = await getMongoDb();
  return Boolean(await db.collection("whatsappMessages").findOne({ bookingCode, category, status: { $ne: "rate_limited" } }));
}

export function buildTripReminderText(reservation: Record<string, any>, trip: Record<string, any>) {
  const lines = ["حافلة سهود", "تذكير بموعد الرحلة", `مرحباً ${String(reservation.passengerName ?? "")}،`, `رحلتك: ${String(trip.routeName ?? reservation.tripCode ?? "")}`, `المقعد: ${String(reservation.seatNumber ?? "")}`, `الموعد: ${trip.departureAt ? new Date(trip.departureAt).toLocaleString("ar-SA") : "غير محدد"}`, "يرجى الحضور قبل موعد الانطلاق بوقت كافٍ."];
  if (reservation.branchName) lines.push(`اسم الفرع: ${String(reservation.branchName)}`);
  if (reservation.branchContactPhone) lines.push(`رقم الفرع: ${String(reservation.branchContactPhone)}`);
  if (reservation.branchLocationUrl) lines.push(`موقع الفرع: ${String(reservation.branchLocationUrl)}`);
  return lines.join("\n");
}

export function buildFeedbackPrompt(reservation: Record<string, any>, trip: Record<string, any>) {
  return ["حافلة سهود", `مرحباً ${String(reservation.passengerName ?? "")}، نتمنى أن تكون رحلتك ${String(trip.routeName ?? "")} قد كانت مريحة.`, "كيف كانت الخدمة؟", "اكتب 1 إذا كانت التجربة جيدة لنرسل لك رابط التقييم على Google Maps.", "اكتب 2 إذا واجهتك أي مشكلة، أو اكتب تفاصيل المشكلة مباشرةً؛ سنعتذر ونتواصل معك لفهمها وتقديم ما يلزم."].join("\n");
}

export function shouldAutoCloseTrip(trip: { departureAt?: unknown; status?: unknown }, now = new Date()) {
  const departureAt = new Date(String(trip.departureAt ?? ""));
  return ["open", "boarding", "departed"].includes(String(trip.status)) && !Number.isNaN(departureAt.valueOf()) && departureAt.valueOf() <= now.valueOf();
}

export async function closeExpiredTrips(now = new Date()) {
  const db = await getMongoDb();
  const candidates = await db.collection("trips").find({ status: { $in: ["open", "boarding", "departed"] }, departureAt: { $lte: now } }, { projection: { _id: 0, code: 1, status: 1, departureAt: 1 } }).toArray();
  const tripCodes = candidates.filter(trip => shouldAutoCloseTrip(trip as { departureAt?: unknown; status?: unknown }, now)).map(trip => String(trip.code));
  if (!tripCodes.length) return 0;
  const result = await db.collection("trips").updateMany({ code: { $in: tripCodes }, status: { $in: ["open", "boarding", "departed"] } }, { $set: { status: "closed", autoClosedAt: now, closureReason: "departure_time_elapsed", updatedAt: now } });
  return result.modifiedCount;
}

export async function runTripAutomation(now = new Date()) {
  const db = await getMongoDb();
  const settings = await getTripAutomationSettings();
  const closedTrips = await closeExpiredTrips(now);
  const session = await db.collection("wasenderSessions").findOne({ isActive: true, status: "connected" });
  if (!session) return { skipped: "whatsapp_not_connected", closedTrips, reminders: 0, feedback: 0 };
  let reminders = 0; let feedback = 0;
  if (settings.reminderEnabled) {
    const latestDeparture = new Date(now.getTime() + settings.reminderLeadMinutes * 60_000);
    const trips = await db.collection("trips").find({ status: { $in: ["open", "boarding"] }, departureAt: { $gt: now, $lte: latestDeparture } }).toArray();
    for (const trip of trips) {
      const reservations = await db.collection("reservations").find({ tripCode: trip.code }).toArray();
      for (const reservation of reservations) {
        if (await alreadyQueued(String(reservation.reservationCode), "trip_reminder")) continue;
        await sendWasenderText({ to: String(reservation.phone), text: buildTripReminderText(reservation, trip), bookingType: "reservation", bookingCode: String(reservation.reservationCode), mode: "automatic", category: "trip_reminder", createdByUserId: 0 });
        reminders += 1;
      }
    }
  }
  if (settings.feedbackEnabled) {
    const feedbackDueAt = new Date(now.getTime() - settings.feedbackDelayMinutes * 60_000);
    const oldestTrip = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const trips = await db.collection("trips").find({ status: { $in: ["departed", "closed"] }, departureAt: { $gte: oldestTrip, $lte: feedbackDueAt } }).toArray();
    for (const trip of trips) {
      const reservations = await db.collection("reservations").find({ tripCode: trip.code }).toArray();
      for (const reservation of reservations) {
        if (await alreadyQueued(String(reservation.reservationCode), "feedback_request")) continue;
        await sendWasenderText({ to: String(reservation.phone), text: buildFeedbackPrompt(reservation, trip), bookingType: "reservation", bookingCode: String(reservation.reservationCode), mode: "automatic", category: "feedback_request", createdByUserId: 0 });
        feedback += 1;
      }
    }
  }
  return { closedTrips, reminders, feedback, ranAt: now.toISOString() };
}

export async function handleTripAutomationCron(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
    const db = await getMongoDb();
    const settings = await db.collection("automationSettings").findOne({ _id: SETTINGS_ID, scheduleCronTaskUid: user.taskUid } as any);
    if (!settings) return res.status(200).json({ ok: true, skipped: "orphan-or-mismatched-task", taskUid: user.taskUid });
    const result = await runTripAutomation();
    return res.status(200).json({ ok: true, taskUid: user.taskUid, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, timestamp: new Date().toISOString(), context: { path: req.path } });
  }
}
