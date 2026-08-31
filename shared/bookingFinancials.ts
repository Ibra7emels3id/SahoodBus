function calculateNetOfficeRevenue(ticketPrice: number, deduction: number, deductionLabel: string) {
  if (!Number.isFinite(ticketPrice) || !Number.isFinite(deduction)) {
    return { valid: false as const, officeRevenue: 0, message: "أدخل قيماً مالية صحيحة." };
  }
  if (ticketPrice < 0 || deduction < 0) {
    return { valid: false as const, officeRevenue: 0, message: "لا يمكن أن تكون القيم المالية سالبة." };
  }
  if (deduction > ticketPrice) {
    return { valid: false as const, officeRevenue: 0, message: `${deductionLabel} لا يمكن أن تتجاوز إجمالي سعر التذكرة.` };
  }
  return { valid: true as const, officeRevenue: ticketPrice - deduction };
}

export function calculateOfficeRevenue(ticketPrice: number, driverCommission: number) {
  return calculateNetOfficeRevenue(ticketPrice, driverCommission, "عمولة السائق");
}

export function calculateExternalOfficeRevenue(ticketPrice: number, externalOfficeFee: number) {
  return calculateNetOfficeRevenue(ticketPrice, externalOfficeFee, "رسوم المكتب الخارجي");
}
