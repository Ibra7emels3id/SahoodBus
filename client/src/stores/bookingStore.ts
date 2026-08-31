import { calculateOfficeRevenue } from "../../../shared/bookingFinancials";
import { create } from "zustand";

export type TripItem = {
  code: string;
  route: string;
  date: string;
  time: string;
  departureAt?: string;
  createdAt?: string;
  bus: string;
  driver: string;
  secondDriver: string;
  branchId?: number | null;
  branchName?: string;
  sharedBranchId?: number | null;
  sharedBranchName?: string | null;
  capacity: number;
  bookedSeats: number[];
  status: "open" | "boarding" | "departed" | "closed";
};

export type ReservationItem = {
  id: string;
  tripCode: string;
  passengerName: string;
  phone: string;
  nationality: string;
  passportNumber: string;
  birthDate: string;
  luggageCount: number;
  passengerType: "بالغ" | "طفل";
  paymentMethod: "نقدي" | "شبكة";
  seatNumber: number;
  ticketPrice: number;
  driverCommission: number;
  officeRevenue: number;
  branchContactPhone?: string;
  createdAt: string;
};

type TripDraft = Omit<TripItem, "bookedSeats"> & { bookedSeats?: number[] };
type ReservationDraft = Omit<ReservationItem, "id" | "officeRevenue" | "createdAt">;

type BookingState = {
  trips: TripItem[];
  reservations: ReservationItem[];
  setTrips: (trips: TripItem[]) => void;
  setReservations: (reservations: ReservationItem[]) => void;
  addTrip: (trip: TripItem) => void;
  updateTrip: (code: string, updates: Partial<Omit<TripItem, "code" | "bookedSeats">>) => void;
  addReservation: (reservation: ReservationDraft) => { success: boolean; message?: string };
};

const seatSeries = (last: number) => Array.from({ length: last }, (_, index) => index + 1);

export const defaultTrips: TripItem[] = [];

export const useBookingStore = create<BookingState>()((set, get) => ({
  trips: defaultTrips,
  reservations: [],
  setTrips: trips => set({ trips }),
  setReservations: reservations => set({ reservations }),
  addTrip: trip => set(state => ({ trips: [trip, ...state.trips] })),
  updateTrip: (code, updates) => set(state => ({
    trips: state.trips.map(trip => trip.code === code ? { ...trip, ...updates } : trip),
  })),
  addReservation: reservation => {
    const trip = get().trips.find(item => item.code === reservation.tripCode);
    if (!trip) return { success: false, message: "تعذر العثور على الرحلة." };
    if (trip.bookedSeats.includes(reservation.seatNumber)) return { success: false, message: "هذا المقعد محجوز بالفعل." };
    if (reservation.seatNumber < 1 || reservation.seatNumber > trip.capacity) return { success: false, message: "رقم المقعد خارج سعة الحافلة." };
    const financials = calculateOfficeRevenue(reservation.ticketPrice, reservation.driverCommission);
    if (!financials.valid) return { success: false, message: financials.message };
    const createdAt = new Date().toISOString();
    const id = `SH-${String(Date.now()).slice(-6)}`;
    set(state => ({
      reservations: [{ ...reservation, id, officeRevenue: financials.officeRevenue, createdAt }, ...state.reservations],
      trips: state.trips.map(item => item.code === reservation.tripCode ? { ...item, bookedSeats: [...item.bookedSeats, reservation.seatNumber].sort((a, b) => a - b) } : item),
    }));
    return { success: true };
  },
}));
