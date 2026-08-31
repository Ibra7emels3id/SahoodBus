export type TripDraft = {
  primaryDriverName: string;
  secondDriverName: string;
  busNumber: string;
  routeName: string;
  departureDate: string;
  departureTime: string;
  capacity: string;
};

export function validateTripDraft(form: TripDraft) {
  const required = [form.primaryDriverName, form.secondDriverName, form.busNumber, form.routeName, form.departureDate, form.departureTime, form.capacity];
  if (required.some(value => !value.trim())) return { valid: false as const, message: "أكمل جميع بيانات الرحلة المطلوبة." };
  const capacity = Number(form.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 80) return { valid: false as const, message: "عدد المقاعد يجب أن يكون بين 1 و80 مقعداً." };
  return { valid: true as const, capacity };
}
