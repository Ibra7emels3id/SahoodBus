import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { jwtVerify, SignJWT } from "jose";
import type { User } from "../drizzle/schema";
import { getMongoDb } from "./mongo";

const scrypt = promisify(scryptCallback);
const localSessionIssuer = "suhoud-bus-local";
const sessionKey = new TextEncoder().encode(process.env.JWT_SECRET || "suhoud-local-session-key");
export const branchPermissionKeys = ["bookings", "edit_prices", "cashbox", "reports", "exports"] as const;
export type BranchPermission = typeof branchPermissionKeys[number];
const defaultBranchPermissions: BranchPermission[] = ["bookings", "cashbox", "reports", "exports"];

type LocalUserDocument = {
  id: number;
  email: string;
  name: string;
  phone?: string | null;
  passwordHash: string;
  role: "admin" | "user";
  branchId: number | null;
  permissions?: BranchPermission[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

type LocalAuthenticatedUser = User & { branchId: number | null; phone?: string | null; permissions?: BranchPermission[] };

function normalizePermissions(permissions?: string[] | null): BranchPermission[] {
  if (!permissions) return [...defaultBranchPermissions];
  return branchPermissionKeys.filter(permission => permissions.includes(permission));
}

export function hasLocalPermission(user: { role: string; permissions?: BranchPermission[] | null }, permission: BranchPermission) {
  return user.role === "admin" || normalizePermissions(user.permissions).includes(permission);
}

function publicUser(document: LocalUserDocument): LocalAuthenticatedUser {
  return {
    id: document.id,
    openId: `local:${document.id}`,
    email: document.email,
    name: document.name,
    loginMethod: "local",
    role: document.role,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastSignedIn: document.lastSignedIn,
    branchId: document.branchId,
    phone: document.phone ?? null,
    permissions: document.role === "admin" ? [...branchPermissionKeys] : normalizePermissions(document.permissions),
  };
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
}

function hashResetCode(code: string) {
  return createHash("sha256").update(`suhoud-password-reset:${code}`).digest("hex");
}

async function ensureInitialAdmin(email: string) {
  const configuredEmail = process.env.LOCAL_ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.LOCAL_ADMIN_PASSWORD;
  if (!configuredEmail || !configuredPassword || configuredEmail !== email) return null;
  const db = await getMongoDb();
  const collection = db.collection<LocalUserDocument>("localUsers");
  const existing = await collection.findOne({ email: configuredEmail });
  if (existing) return existing;
  const now = new Date();
  const user: LocalUserDocument = { id: Date.now(), email: configuredEmail, name: "مدير النظام", passwordHash: await hashPassword(configuredPassword), role: "admin", branchId: null, isActive: true, createdAt: now, updatedAt: now, lastSignedIn: now };
  await collection.insertOne(user);
  return user;
}

export async function loginWithEmailPassword(emailInput: string, password: string) {
  const email = emailInput.trim().toLowerCase();
  const db = await getMongoDb();
  const collection = db.collection<LocalUserDocument>("localUsers");
  const user = await collection.findOne({ email }) ?? await ensureInitialAdmin(email);
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) return null;
  const now = new Date();
  await collection.updateOne({ id: user.id }, { $set: { lastSignedIn: now, updatedAt: now } });
  const authenticatedUser = publicUser({ ...user, lastSignedIn: now, updatedAt: now });
  const token = await new SignJWT({ email: authenticatedUser.email, role: authenticatedUser.role, branchId: user.branchId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(localSessionIssuer)
    .setSubject(String(authenticatedUser.id))
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(sessionKey);
  return { token, user: authenticatedUser };
}

export async function getLocalUserFromToken(token: string): Promise<LocalAuthenticatedUser | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey, { issuer: localSessionIssuer });
    const id = Number(payload.sub);
    if (!Number.isSafeInteger(id)) return null;
    const db = await getMongoDb();
    const user = await db.collection<LocalUserDocument>("localUsers").findOne({ id });
    return user ? publicUser(user) : null;
  } catch {
    return null;
  }
}

export async function createLocalBranchUser(input: { email: string; password: string; name: string; phone?: string | null; branchId?: number | null; permissions?: BranchPermission[] }) {
  const email = input.email.trim().toLowerCase();
  const db = await getMongoDb();
  const collection = db.collection<LocalUserDocument>("localUsers");
  if (await collection.findOne({ email })) return null;
  const now = new Date();
  const user: LocalUserDocument = { id: Date.now(), email, name: input.name.trim(), phone: input.phone?.trim() || null, passwordHash: await hashPassword(input.password), role: "user", branchId: input.branchId ?? null, permissions: normalizePermissions(input.permissions), isActive: true, createdAt: now, updatedAt: now, lastSignedIn: now };
  await collection.insertOne(user);
  return publicUser(user);
}

export async function listLocalUsers() {
  const db = await getMongoDb();
  const users = await db.collection<LocalUserDocument>("localUsers").find({}, { projection: { passwordHash: 0, _id: 0 } }).sort({ createdAt: -1 }).toArray();
  return users.map(({ id, email, name, phone, role, branchId, permissions, isActive, createdAt, lastSignedIn }) => ({ id, email, name, phone: phone ?? null, role, branchId, permissions: role === "admin" ? [...branchPermissionKeys] : normalizePermissions(permissions), isActive, createdAt, lastSignedIn }));
}

export async function updateLocalUser(input: { id: number; name: string; email: string; phone?: string | null; branchId?: number | null; permissions?: BranchPermission[] }) {
  const db = await getMongoDb();
  const collection = db.collection<LocalUserDocument>("localUsers");
  const email = input.email.trim().toLowerCase();
  const duplicate = await collection.findOne({ email, id: { $ne: input.id } });
  if (duplicate) return { updated: false, reason: "duplicate-email" as const };
  const result = await collection.updateOne({ id: input.id }, { $set: { name: input.name.trim(), email, phone: input.phone?.trim() || null, ...(input.branchId !== undefined ? { branchId: input.branchId } : {}), ...(input.permissions !== undefined ? { permissions: normalizePermissions(input.permissions) } : {}), updatedAt: new Date() } });
  return { updated: result.matchedCount > 0, reason: result.matchedCount ? null : "not-found" as const };
}

export async function setLocalUserActive(id: number, isActive: boolean) {
  const db = await getMongoDb();
  const result = await db.collection<LocalUserDocument>("localUsers").updateOne({ id }, { $set: { isActive, updatedAt: new Date() } });
  return result.matchedCount > 0;
}

export async function issueLocalPasswordReset(emailInput: string) {
  const email = emailInput.trim().toLowerCase();
  const db = await getMongoDb();
  const user = await db.collection<LocalUserDocument>("localUsers").findOne({ email, isActive: true });
  if (!user?.phone?.trim()) return null;
  const requests = db.collection("passwordResetRequests");
  const now = new Date();
  const latest = await requests.findOne({ userId: user.id }, { sort: { createdAt: -1 } });
  if (latest?.createdAt instanceof Date && now.valueOf() - latest.createdAt.valueOf() < 60_000) return null;
  const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  const resetId = `PWD-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await requests.insertOne({ resetId, userId: user.id, email, codeHash: hashResetCode(code), attemptCount: 0, createdAt: now, expiresAt: new Date(now.valueOf() + 10 * 60_000), usedAt: null });
  return { resetId, code, phone: user.phone.trim(), userId: user.id };
}

export async function completeLocalPasswordReset(input: { email: string; code: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const db = await getMongoDb();
  const users = db.collection<LocalUserDocument>("localUsers");
  const user = await users.findOne({ email, isActive: true });
  if (!user) return false;
  const requests = db.collection("passwordResetRequests");
  const reset = await requests.findOne({ userId: user.id, usedAt: null, expiresAt: { $gt: new Date() } }, { sort: { createdAt: -1 } });
  if (!reset || Number(reset.attemptCount ?? 0) >= 5 || hashResetCode(input.code.trim()) !== String(reset.codeHash)) {
    if (reset?._id) await requests.updateOne({ _id: reset._id }, { $inc: { attemptCount: 1 }, $set: { updatedAt: new Date() } });
    return false;
  }
  const now = new Date();
  await users.updateOne({ id: user.id }, { $set: { passwordHash: await hashPassword(input.password), passwordResetAt: now, updatedAt: now } });
  await requests.updateOne({ _id: reset._id }, { $set: { usedAt: now, updatedAt: now } });
  return true;
}

export async function resetLocalUserPassword(id: number, password: string) {
  const db = await getMongoDb();
  const now = new Date();
  const result = await db.collection<LocalUserDocument>("localUsers").updateOne({ id }, { $set: { passwordHash: await hashPassword(password), passwordResetAt: now, updatedAt: now } });
  return result.matchedCount > 0;
}
